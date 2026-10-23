import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createTcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(dirname(require.resolve("@ahpd/server/package.json")), "dist/main.js");
const acpPlugin = dirname(dirname(require.resolve("@ahpd/agent-acp")));
const fakeAcp = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

async function waitForPort(port, child, getOutput) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw Error(`Isolated ahpd exited early (${child.exitCode ?? child.signalCode}): ${getOutput()}`);
    }
    if (await probePort(port)) return;
    await pause(100);
  }
  throw Error(`Isolated ahpd did not open its port: ${getOutput()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const close = new Promise((resolve) => child.once("close", resolve));
  const closeWithin = async (ms) => {
    let timer;
    try {
      return await Promise.race([
        close.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Each daemon is its own process group, so its owned ACP children receive
  // the same signal. Never search for or kill unrelated host processes.
  const signal = (name) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      // A child started without a new process group still has an exact PID.
      child.kill(name);
    }
  };
  signal("SIGTERM");
  const closed = await closeWithin(3500);
  if (!closed && child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    if (!await closeWithin(2000)) throw Error(`Owned process ${child.pid} did not exit`);
  }
}

async function isolatedHost(root, name, origin) {
  const base = join(root, name);
  const workspace = join(base, "workspace");
  const configHome = join(base, "config");
  const configDir = join(configHome, "ahpd");
  const tokenPath = join(configDir, "token");
  const configFile = join(configDir, "config.json");
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({
    host: "127.0.0.1",
    port,
    paths: [workspace],
    connectionTokenFile: tokenPath,
    origins: origin ? [origin] : [],
    automations: "memory",
    plugins: [{
      name: acpPlugin,
      options: {
        presets: {
          relayFixture: {
            name: "Relay ACP Fixture",
            command: process.execPath,
            args: [fakeAcp],
            honoursTrust: true,
          },
        },
      },
    }],
  }));

  let processHandle;
  let output = "";
  const start = async () => {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      throw Error("Fixture daemon is already running");
    }
    output = "";
    processHandle = spawn(process.execPath, [serverEntry, "--config-file", configFile,
      "--no-cwd", "--no-update-check"], {
      cwd: base,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: join(base, "cache"),
        XDG_STATE_HOME: join(base, "state"),
        XDG_DATA_HOME: join(base, "data"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Keep a bounded diagnostic tail and never echo the generated token.
    for (const stream of [processHandle.stdout, processHandle.stderr]) {
      stream.on("data", (chunk) => { output = (output + String(chunk)).slice(-6000); });
    }
    try {
      await waitForPort(port, processHandle, () => output.replaceAll(token, "[redacted]"));
    } catch (error) {
      await stopChild(processHandle);
      throw error;
    }
  };
  const stop = async () => stopChild(processHandle);
  await start();
  return {
    name, port, token, workspace,
    origin: `ws://127.0.0.1:${port}`,
    start, stop,
    restart: async () => { await stop(); await start(); },
  };
}

export async function isolatedFleet(t, { hostCount = 1, withWeb = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "relay-ahp-qa-"));
  const hosts = [];
  let webChild;
  const webPort = withWeb ? await freePort() : 0;
  const webOrigin = withWeb ? `http://127.0.0.1:${webPort}` : undefined;
  const cleanup = async () => {
    const results = await Promise.allSettled([stopChild(webChild), ...hosts.map((host) => host.stop())]);
    await rm(root, { recursive: true, force: true });
    const failures = results.filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Isolated fixture cleanup failed");
  };
  t.after(cleanup);
  try {
    for (let i = 0; i < hostCount; i++) {
      hosts.push(await isolatedHost(root, `host-${i + 1}`, webOrigin));
    }
    if (withWeb) {
      webChild = spawn(process.execPath, [join(repo, "src/serve.mjs")], {
        cwd: repo, env: { ...process.env, PORT: String(webPort) },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForPort(webPort, webChild, () => "Relay web server failed");
    }
    return { hosts, webOrigin, root };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function launchBrowser() {
  const options = { headless: true, args: ["--disable-dev-shm-usage"] };
  if (!existsSync(chromium.executablePath())) {
    const candidates = process.env.RELAY_TEST_CHROMIUM_PATH
      ? [process.env.RELAY_TEST_CHROMIUM_PATH] : ["chromium", "google-chrome", "google-chrome-stable"];
    for (const candidate of candidates) {
      if (existsSync(candidate)) { options.executablePath = candidate; break; }
      const found = spawnSync("which", [candidate], { encoding: "utf8" });
      if (found.status === 0) { options.executablePath = found.stdout.trim(); break; }
    }
  }
  return chromium.launch(options);
}
