import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(project, "docs/media");
const ui = resolve(project, "ui/index.html");
try { await access(ui); } catch { throw new Error("the integrated UI is missing; no capture was created"); }
const target = process.env.RELAY_CAPTURE_URL;
if (!target) throw new Error("set RELAY_CAPTURE_URL to the running disposable Relay demo UI on loopback");
let url;
try { url = new URL(target); } catch { throw new Error("RELAY_CAPTURE_URL must be a valid loopback URL"); }
if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
  throw new Error("capture is restricted to a loopback origin without credentials, query, or fragment");
}
const executable = process.env.RELAY_BROWSER ?? findBrowser();
if (!executable) throw new Error("no Chromium executable was found; set RELAY_BROWSER to an installed browser path");
const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
if (version.status !== 0 || version.error) throw new Error("the selected browser did not report its version");

const profile = await mkdtemp(resolve(tmpdir(), "relay-capture-profile-"));
const width = 1440;
const height = 1000;
const args = [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-sync", "--disable-extensions", "--disable-background-networking", "--hide-scrollbars",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
  `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${resolve(output, "topology.png")}`, url.origin,
];
let failure;
try {
  await mkdir(output, { recursive: true });
  await run(executable, args, 20_000);
  const narrow = args.map((arg) => arg.startsWith("--window-size=") ? "--window-size=390,844" : arg.startsWith("--screenshot=") ? `--screenshot=${resolve(output, "topology-narrow.png")}` : arg);
  await run(executable, narrow, 20_000);
  const evidence = {
    capturedAt: new Date().toISOString(),
    browser: version.stdout.trim() || version.stderr.trim(),
    runtime: process.version,
    viewport: { wide: { width, height }, narrow: { width: 390, height: 844 } },
    url: url.origin,
    profile: "fresh temporary Chromium profile",
  };
  await writeFile(resolve(output, "capture.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ files: ["docs/media/topology.png", "docs/media/topology-narrow.png", "docs/media/capture.json"], browser: evidence.browser, runtime: evidence.runtime })}\n`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (!resolve(profile).startsWith(resolve(tmpdir()) + sep)) throw new Error("refusing to remove a browser profile outside the owned temporary directory");
  try { await rm(profile, { recursive: true, force: true }); }
  catch (error) {
    if (failure) process.stderr.write(`capture cleanup after primary failure: ${error.message}\n`);
    else throw error;
  }
}

function findBrowser() {
  for (const name of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    const result = spawnSync("which", [name], { encoding: "utf8", timeout: 2_000 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

function run(command, childArgs, timeout) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, childArgs, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let killTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeout);
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk.slice(0, Math.max(0, 8_192 - stderr.length)); });
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (code === 0) resolveRun();
      else reject(new Error(`browser capture failed (${signal ?? code}): ${stderr.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 1_000)}`));
    });
  });
}
