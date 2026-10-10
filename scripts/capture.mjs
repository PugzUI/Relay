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
const maxProtocolBytes = 1_048_576;
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

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

export function capturePageState(state, { origin, width, height }) {
  if (!state || state.origin !== origin || state.blank || !state.ready
    || state.viewportWidth !== width || state.viewportHeight !== height
    || state.documentWidth !== width || state.horizontalOverflow
    || state.connection !== "connected" || !state.selectedBoard
    || state.loading || state.error || state.topologyItems < 1 || state.inbox < 1 || state.bounties < 1
    || state.inboxState !== "Ready" || state.bountiesState !== "Ready") {
    throw new Error(`capture page state is invalid: ${JSON.stringify({
      expected: { width, height },
      viewport: { width: state?.viewportWidth, height: state?.viewportHeight },
      document: { width: state?.documentWidth, height: state?.documentHeight, overflow: state?.horizontalOverflow },
      originMatches: state?.origin === origin, ready: state?.ready, connection: state?.connection,
      selectedBoardPresent: Boolean(state?.selectedBoard), loading: state?.loading, error: state?.error,
      topologyItems: state?.topologyItems, inboxRows: state?.inbox, workRows: state?.bounties,
      inboxReady: state?.inboxState === "Ready", workReady: state?.bountiesState === "Ready",
    })}`);
  }
  return {
    origin: state.origin,
    selectedBoard: state.selectedBoard,
    viewport: { width: state.viewportWidth, height: state.viewportHeight },
    document: { width: state.documentWidth, height: state.documentHeight, horizontalOverflow: state.horizontalOverflow },
    topologyItems: state.topologyItems,
    panes: { inboxRows: state.inbox, bountiesRows: state.bounties },
    connection: state.connection,
    paneStates: { inbox: state.inboxState, bounties: state.bountiesState },
  };
}

export function captureEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/(?:^DISPLAY$|WAYLAND|XAUTHORITY|DBUS_SESSION|XDG_RUNTIME|XDG_SESSION|HYPRLAND|SWAYSOCK|SESSION_MANAGER|DESKTOP_SESSION|XDG_CURRENT_DESKTOP|^RELAY_CAPTURE_)/i.test(key)));
}

export function pngDimensions(image) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (image.length < 24 || !image.subarray(0, 8).equals(signature) || image.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("browser did not return a PNG screenshot");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error("browser returned invalid screenshot dimensions");
  return { width, height };
}

export async function readCaptureToken(path = process.env.RELAY_CAPTURE_TOKEN_FILE) {
  if (!path) throw new Error("set RELAY_CAPTURE_TOKEN_FILE to a private Relay token file");
  const tokenPath = resolve(path);
  let handle;
  try { handle = await open(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)); }
  catch { throw new Error("capture token file could not be opened safely"); }
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
      throw new Error("capture token file must be an owned, regular, private file");
    }
    if (info.size > 44) throw new Error("capture token file has an invalid size");
    bytes = Buffer.alloc(45);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 44) throw new Error("capture token file has an invalid size");
    const token = bytes.toString("utf8", 0, length).replace(/\n$/, "");
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
  ], { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"], env: captureEnvironment() });
  let launchError = false;
  child.once("error", () => { launchError = true; });
  let cdp;
  let failure;
  let runtimeExceptions = 0;
  try {
    const endpoint = await devtoolsEndpoint(profile, child, () => launchError);
    cdp = await Cdp.connect(endpoint);
    cdp.addEventListener("Runtime.exceptionThrown", () => { runtimeExceptions += 1; });
    const ready = new Promise((resolveReady) => {
      cdp.once("Page.loadEventFired", resolveReady);
      setTimeout(resolveReady, 1_500).unref();
    });
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Page.navigate", { url: target });
    await ready;
    await cdp.evaluate(`(() => {
      const input = document.getElementById("token");
      const form = document.getElementById("auth-form");
      if (location.origin !== ${JSON.stringify(target)} || location.pathname !== "/"
        || !(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
        throw new Error("unexpected capture login origin or form");
      }
      form.addEventListener("submit", (event) => event.preventDefault(), { once: true });
      input.value = ${JSON.stringify(token)};
      form.requestSubmit();
    })()`);
    await waitForConnectedData(cdp, target);

    const views = [
      { name: "topology.png", width: 1440, height: 1000, mobile: false, scroll: false },
      { name: "readme.png", width: 1000, height: 900, mobile: false, scroll: false },
      { name: "topology-narrow.png", width: 390, height: 844, mobile: true, scroll: false },
      { name: "board-narrow.png", width: 390, height: 1200, mobile: true, scroll: true },
    ];
    const measured = {};
    for (const viewport of views) {
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
      });
      await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await cdp.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await waitForConnectedData(cdp, target);
      if (viewport.scroll) await cdp.evaluate("document.querySelector('.boards-section').scrollIntoView({ block: 'start' })");
      const state = await cdp.evaluate(`(() => {
        const root = document.documentElement;
        const inboxStatus = document.getElementById("inbox-status");
        const bountiesStatus = document.getElementById("bounties-status");
        return {
          origin: location.origin,
          blank: !document.body || !document.body.children.length,
          ready: document.readyState === "complete",
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: root.scrollWidth,
          documentHeight: root.scrollHeight,
          horizontalOverflow: root.scrollWidth > root.clientWidth,
          connection: document.getElementById("connection")?.dataset.state ?? "missing",
          selectedBoard: document.getElementById("board-picker")?.value ?? "",
          topologyItems: document.querySelectorAll("#topology [data-entity], #topology [data-board]").length,
          inbox: document.querySelectorAll("#inbox-rows > li").length,
          bounties: document.querySelectorAll("#bounties-rows > li").length,
          inboxState: inboxStatus?.dataset.state || inboxStatus?.textContent || "missing",
          bountiesState: bountiesStatus?.dataset.state || bountiesStatus?.textContent || "missing",
          loading: [inboxStatus, bountiesStatus].some((node) => node?.textContent === "Loading"),
          error: [document.getElementById("connection"), document.getElementById("topology-status"), inboxStatus, bountiesStatus]
            .some((node) => node?.dataset.state === "error"),
        };
      })()`);
      measured[viewport.name] = capturePageState(state, { origin: target, width: viewport.width, height: viewport.height });
      const accessibility = await cdp.evaluate(`(() => {
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const probe = document.createElement("span");
        probe.style.animation = "capture-probe 2s infinite";
        document.body.append(probe);
        const motion = getComputedStyle(probe);
        const result = { reduce, animation: motion.animationDuration, iterations: motion.animationIterationCount };
        probe.remove();
        return result;
      })()`);
      if (!accessibility.reduce || accessibility.animation.split(",").some((duration) => Number.parseFloat(duration) > 0.01)
        || accessibility.iterations.split(",").some((count) => Number.parseFloat(count) > 1)) {
        throw new Error("reduced-motion browser emulation was not applied");
      }
      if (viewport.name === "topology-narrow.png") {
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        const focus = await cdp.evaluate(`(() => {
          const active = document.activeElement;
          return { visible: active instanceof HTMLElement && active.matches(":focus-visible"), outline: active instanceof HTMLElement && getComputedStyle(active).outlineStyle !== "none" };
        })()`);
        if (!focus.visible || !focus.outline) throw new Error("keyboard focus is not visibly outlined on a real control");
      }
      const result = await cdp.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      if (typeof result.data !== "string" || result.data.length > 16_000_000) throw new Error("browser returned an invalid or oversized screenshot");
      const image = Buffer.from(result.data, "base64");
      const pixels = pngDimensions(image);
      if (pixels.width !== viewport.width || pixels.height !== viewport.height) throw new Error("screenshot pixel dimensions do not match the measured viewport");
      measured[viewport.name].pixels = pixels;
      if (runtimeExceptions) throw new Error(`page raised ${runtimeExceptions} uncaught runtime exception(s)`);
      await writeFile(join(staging, viewport.name), image, { mode: 0o600, flag: "wx" });
    }
    if (runtimeExceptions) throw new Error(`page raised ${runtimeExceptions} uncaught runtime exception(s)`);
    const evidence = {
      capturedAt: new Date().toISOString(),
      browser: version,
      runtime: process.version,
      views: measured,
      profile: "fresh temporary Chromium profile",
      authenticated: true,
      runtimeExceptions,
      reducedMotion: "emulated and verified",
      keyboardFocus: "visible outline verified on a real control",
    };
    await writeFile(join(staging, "capture.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await mkdir(output, { recursive: true });
    const filenames = [...views.map((view) => view.name), "capture.json"];
    for (const name of filenames) {
      await rename(join(staging, name), join(output, name));
    }
    process.stdout.write(`${JSON.stringify({ files: filenames.map((name) => `docs/media/${name}`), browser: version, runtime: process.version })}\n`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    try { await cdp?.close(); } catch { cleanupFailed = true; }
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

async function waitForConnectedData(cdp, expectedOrigin) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const status = document.getElementById("connection");
      const topology = document.getElementById("topology");
      const inboxStatus = document.getElementById("inbox-status");
      const bountyStatus = document.getElementById("bounties-status");
      return {
        ready: document.readyState === "complete",
        origin: location.origin,
        blank: !document.body || !document.body.children.length,
        connection: status?.dataset.state ?? "missing",
        selectedBoard: document.getElementById("board-picker")?.value ?? "",
        topology: topology?.querySelectorAll("[data-entity], [data-board]").length ?? 0,
        inbox: document.querySelectorAll("#inbox-rows > li").length,
        bounties: document.querySelectorAll("#bounties-rows > li").length,
        loading: [inboxStatus, bountyStatus].some((node) => node?.textContent === "Loading"),
        error: [status, document.getElementById("topology-status"), inboxStatus, bountyStatus]
          .some((node) => node?.dataset.state === "error"),
      };
    })()`);
    if (state.error) throw new Error("Relay denied authentication or returned an error while loading capture data");
    if (state.ready && state.origin === expectedOrigin && !state.blank && state.connection === "connected"
      && state.topology > 0 && state.selectedBoard && state.inbox > 0 && state.bounties > 0 && !state.loading) return;
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

export async function devtoolsEndpoint(profile, child, hasLaunchError) {
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
          const body = await readBoundedResponse(response, 65_536);
          const targets = JSON.parse(body);
          const page = targets.find((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
          if (page && validDebuggerUrl(page.webSocketDebuggerUrl, port)) return page.webSocketDebuggerUrl;
        }
      }
    } catch { /* browser is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("timed out waiting for the owned browser debugging endpoint");
}

async function readBoundedResponse(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("browser target list has no response body");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("browser target list exceeds its limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function validDebuggerUrl(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && Number(url.port) === port
      && /^\/devtools\/page\//.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function stopOwnedBrowser(child) {
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

export class Cdp extends EventTarget {
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
      if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > maxProtocolBytes) {
        client.fail(new Error("browser protocol frame exceeds its limit"));
        client.socket.close();
        return;
      }
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
    if (this.pending.size >= 64) return Promise.reject(new Error("too many pending browser commands"));
    const id = ++this.nextId;
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload, "utf8") > maxProtocolBytes) return Promise.reject(new Error("browser command exceeds its limit"));
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`browser command timed out: ${method}`));
      }, 5_000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try { this.socket.send(payload); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCall(new Error("could not send browser command", { cause: error }));
      }
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

  async close() {
    if (!this.socket) return;
    this.fail(new Error("browser connection closed"));
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolveClosed) => this.socket.addEventListener("close", resolveClosed, { once: true }));
    this.socket.close();
    if (!await Promise.race([closed.then(() => true), delay(1_000).then(() => false)])) {
      throw new Error("browser connection did not close within its limit");
    }
  }
}

if (isMain) await capture();
