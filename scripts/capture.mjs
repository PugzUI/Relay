import { access, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(project, "docs/media");
const ui = resolve(project, "ui/index.html");
const timeoutMs = 30_000;
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) await capture();

export function captureUrl(value = process.env.RELAY_CAPTURE_URL ?? "http://127.0.0.1:4200") {
  let url;
  try { url = new URL(value); } catch { throw new Error("RELAY_CAPTURE_URL must be a valid loopback origin"); }
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname)
    || !["http:", "https:"].includes(url.protocol)
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("RELAY_CAPTURE_URL must be a loopback origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export async function readCaptureToken(path = process.env.RELAY_CAPTURE_TOKEN_FILE) {
  if (!path) throw new Error("set RELAY_CAPTURE_TOKEN_FILE to a private Relay token file");
  const tokenPath = resolve(path);
  let handle;
  try { handle = await open(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { throw new Error("capture token file could not be opened safely"); }
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("capture token file must be a regular, private file");
    }
    if (info.size > 44) throw new Error("capture token file has an invalid size");
    bytes = await handle.readFile();
    const token = bytes.toString("utf8").replace(/\n$/, "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("capture token file has an invalid token");
    return token;
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

async function capture() {
  await access(ui);
  const target = captureUrl();
  const token = await readCaptureToken();
  const executable = await findBrowser(process.env.RELAY_BROWSER);
  const version = browserVersion(executable);
  const profile = await mkdtemp(join(tmpdir(), "relay-capture-profile-"));
  const staging = await mkdtemp(join(tmpdir(), "relay-capture-output-"));
  const child = spawn(executable, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-extensions", "--disable-background-networking", "--hide-scrollbars",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
    `--user-data-dir=${profile}`, "about:blank",
  ], { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"] });
  let launchError = false;
  child.once("error", () => { launchError = true; });
  let cdp;
  let failure;
  try {
    const endpoint = await devtoolsEndpoint(profile, child, () => launchError);
    cdp = await Cdp.connect(endpoint);
    const ready = new Promise((resolveReady) => {
      cdp.once("Page.loadEventFired", resolveReady);
      setTimeout(resolveReady, 1_500).unref();
    });
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Page.navigate", { url: target });
    await ready;
    await cdp.evaluate("document.getElementById('token')?.focus()");
    await cdp.call("Input.insertText", { text: token });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitForConnectedData(cdp);

    const viewports = [
      { name: "topology.png", width: 1440, height: 1000, mobile: false },
      { name: "topology-narrow.png", width: 390, height: 844, mobile: true },
    ];
    for (const viewport of viewports) {
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
      });
      await waitForConnectedData(cdp);
      const result = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      if (typeof result.data !== "string" || result.data.length > 16_000_000) throw new Error("browser returned an invalid or oversized screenshot");
      const image = Buffer.from(result.data, "base64");
      if (image.length < 8 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error("browser did not return a PNG screenshot");
      }
      await writeFile(join(staging, viewport.name), image, { mode: 0o600, flag: "wx" });
    }
    const evidence = {
      capturedAt: new Date().toISOString(),
      browser: version,
      runtime: process.version,
      viewport: { wide: { width: 1440, height: 1000 }, narrow: { width: 390, height: 844 } },
      origin: target,
      profile: "fresh temporary Chromium profile",
      authenticated: true,
      data: "connected topology with Inbox and Bounties rows",
    };
    await writeFile(join(staging, "capture.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await mkdir(output, { recursive: true });
    for (const name of ["topology.png", "topology-narrow.png", "capture.json"]) {
      await rename(join(staging, name), join(output, name));
    }
    process.stdout.write(`${JSON.stringify({ files: ["docs/media/topology.png", "docs/media/topology-narrow.png", "docs/media/capture.json"], browser: version, runtime: process.version })}\n`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    cdp?.close();
    try { if (child.pid) await stopOwnedBrowser(child); }
    catch { cleanupFailed = true; }
    for (const path of [profile, staging]) {
      if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw new Error("refusing to remove a path outside the owned temporary directory");
      try { await rm(path, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed && failure) process.stderr.write("capture cleanup failed after the primary error\n");
    else if (cleanupFailed) {
      throw new Error("capture cleanup failed");
    }
  }
}

async function waitForConnectedData(cdp) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const status = document.getElementById("connection");
      const topology = document.getElementById("topology");
      const inboxStatus = document.getElementById("inbox-status");
      const bountyStatus = document.getElementById("bounties-status");
      return {
        ready: document.readyState === "complete",
        connection: status?.dataset.state ?? "missing",
        topology: topology?.querySelectorAll("[data-entity], [data-board]").length ?? 0,
        inbox: document.querySelectorAll("#inbox-rows > li").length,
        bounties: document.querySelectorAll("#bounties-rows > li").length,
        loading: [inboxStatus, bountyStatus].some((node) => node?.textContent === "Loading"),
        error: [status, document.getElementById("topology-status"), inboxStatus, bountyStatus]
          .some((node) => node?.dataset.state === "error"),
      };
    })()`);
    if (state.error) throw new Error("Relay denied authentication or returned an error while loading capture data");
    if (state.ready && state.connection === "connected" && state.topology > 0
      && state.inbox > 0 && state.bounties > 0 && !state.loading) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("timed out waiting for connected topology, Inbox, and Bounties data");
}

async function findBrowser(explicit) {
  if (explicit) {
    await access(explicit, constants.X_OK).catch(() => { throw new Error("RELAY_BROWSER is not executable"); });
    return resolve(explicit);
  }
  const names = process.platform === "win32"
    ? ["chrome.exe", "msedge.exe", "chromium.exe"]
    : ["chromium", "chromium-browser", "google-chrome", "chrome", "microsoft-edge"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue PATH search */ }
    }
  }
  throw new Error("no Chromium executable found; set RELAY_BROWSER to an installed browser path");
}

function browserVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || result.error) throw new Error("the selected browser did not report its version");
  const version = result.stdout.trim().slice(0, 120);
  if (!version) throw new Error("the selected browser reported an empty version");
  return version;
}

async function devtoolsEndpoint(profile, child, hasLaunchError) {
  const activeFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (hasLaunchError() || child.exitCode !== null) throw new Error("the owned browser exited before becoming ready");
    try {
      const [portText, browserPath] = (await readFile(activeFile, "utf8")).trim().split("\n");
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && /^\/devtools\/browser\//.test(browserPath)) {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000), redirect: "error" });
        if (response.ok) {
          const body = await response.text();
          if (body.length > 65_536) throw new Error("browser target list exceeds its limit");
          const targets = JSON.parse(body);
          const page = targets.find((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
          if (page) return page.webSocketDebuggerUrl;
        }
      }
    } catch { /* browser is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("timed out waiting for the owned browser debugging endpoint");
}

async function stopOwnedBrowser(child) {
  if (child.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  signal("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) return;
  signal("SIGKILL");
  await Promise.race([exited, delay(2_000)]);
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

class Cdp extends EventTarget {
  static async connect(endpoint) {
    const client = new Cdp();
    client.socket = new WebSocket(endpoint);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out connecting to the owned browser")), 5_000);
      client.socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      client.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("could not connect to the owned browser")); }, { once: true });
    });
    client.pending = new Map();
    client.nextId = 0;
    client.socket.addEventListener("message", ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { client.fail(new Error("invalid browser protocol response")); return; }
      if (message.id) {
        const pending = client.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        client.pending.delete(message.id);
        if (message.error) pending.reject(new Error("browser command failed"));
        else pending.resolve(message.result ?? {});
      } else if (message.method) client.dispatchEvent(new CustomEvent(message.method, { detail: message.params }));
    });
    client.socket.addEventListener("close", () => client.fail(new Error("owned browser connection closed")));
    return client;
  }

  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`browser command timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("browser page evaluation failed");
    return result.result?.value;
  }

  once(type, callback) {
    const listener = () => { this.removeEventListener(type, listener); callback(); };
    this.addEventListener(type, listener);
  }

  fail(error) {
    for (const pending of this.pending?.values() ?? []) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending?.clear();
  }

  close() { this.socket?.close(); this.fail(new Error("browser connection closed")); }
}
