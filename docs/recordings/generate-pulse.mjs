import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { open, setup, serve } from "../../src/index.mjs";
import { Cdp, captureEnvironment, devtoolsEndpoint, stopOwnedBrowser } from "../../tests/fixtures/ui/capture.mjs";

const output = join(new URL(".", import.meta.url).pathname, "frames");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = randomBytes(32).toString("base64url");
const grant = { enroll: [], register: [], workers: [], recipients: [], boardPost: [], boardClaim: [], inboxRead: ["bounty"], workRead: ["bounty"], inspect: { messages: false, receipts: false, audit: false, topology: true }, reportDevice: null };
const registry = { version: 1, credentials: [{ principal: "pulse", tokenDigest: hash(token), grant }] };
let parent, relay, broker, browser, cdp;

async function wait(expression, label, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function screenshot(name) {
  await cdp.evaluate("window.scrollTo(0,0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(join(output, `${name}.png`), Buffer.from(image.data, "base64"));
}

try {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  parent = await mkdtemp(join(tmpdir(), "relay-pulse-record-"));
  const root = join(parent, "store");
  const profile = join(parent, "browser");
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const registryPath = join(parent, "registry.json");
  const configPath = join(parent, "config.json");
  setup({ root, device: "pulse", role: "hub" });
  relay = open({ root });
  const worker = relay.register("worker", { slot: "001", caps: ["inspect"] });
  const session = relay.join(worker.id);
  relay.post(session.id, "bounty", { msg: "Initial record" });
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600, flag: "wx" });
  await writeFile(configPath, JSON.stringify({ version: 1, role: "hub", mode: "local", listen: { host: "127.0.0.1", port }, tls: null, allowedPeers: [], credentialsFile: "registry.json", hub: null, pool: null, views: [] }), { mode: 0o600, flag: "wx" });
  broker = await serve({ root, configFile: configPath });
  browser = spawn(process.env.RELAY_BROWSER ?? "/usr/bin/chromium", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-background-networking", "--hide-scrollbars", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { shell: false, detached: true, stdio: "ignore", env: captureEnvironment() });
  cdp = await Cdp.connect(await devtoolsEndpoint(profile, browser, () => false));
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: origin });
  await wait("document.readyState === 'complete' && document.getElementById('auth-form')", "Relay shell");
  await cdp.evaluate(`(() => { const input=document.getElementById('token'); input.value=${JSON.stringify(token)}; document.getElementById('auth-form').requestSubmit(); })()`);
  await wait("document.getElementById('connection').dataset.state === 'connected' && document.getElementById('topology').snapshot !== null", "connected topology");
  await cdp.evaluate("document.querySelector('.worker-node')?.click()");
  await screenshot("00-before");
  await delay(350);
  relay.post(session.id, "bounty", { msg: "Committed interaction" });
  await wait("document.querySelector('.path-pulse') !== null", "committed path pulse");
  for (const [name, ms] of [["01-anticipation", 80], ["02-travel", 180], ["03-impact", 360], ["04-settle", 700], ["05-rest", 1300]]) {
    await delay(ms);
    await screenshot(name);
  }
  assert.equal(await cdp.evaluate("document.querySelectorAll('#inbox-rows > li').length >= 2"), true);
  await broker.close();
  broker = null;
  await cdp.close();
  cdp = null;
  await stopOwnedBrowser(browser);
  browser = null;
  await rm(parent, { recursive: true, force: true });
  parent = null;
  process.stdout.write(`${output}\n`);
} finally {
  try { await cdp?.close(); } catch {}
  try { await broker?.close(); } catch {}
  try { if (browser) await stopOwnedBrowser(browser); } catch {}
  try { if (parent) await rm(parent, { recursive: true, force: true }); } catch {}
}
