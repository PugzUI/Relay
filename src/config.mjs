import { isIP } from "node:net";
import { link, lstat, mkdir, mkdtemp, open as openFile, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Fault } from "./fault.mjs";
import { DELIVERY_CLIENTS, LIMITS } from "./validate.mjs";
import { parseStrictJsonText } from "./strict-json.mjs";

const fail = (message) => { throw new Fault("input", message); };
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys, label) => {
  if (!record(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has unknown or missing fields`);
};
const exactOptional = (value, required, optional, label) => {
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail(`${label} has unknown or missing fields`);
};
const str = (value, label, max = 4096) => {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max || value.includes("\0")) fail(`${label} is invalid`);
  return value;
};
const int = (value, label, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is out of range`);
  return value;
};
const tags = (value, label) => {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length || value.some((v) => typeof v !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(v))) fail(`${label} is invalid`);
  return [...value];
};
const privateFile = async (path, label, { mode = false } = {}) => {
  let handle;
  try { handle = await openFile(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)); }
  catch { throw new Fault("unavailable", `${label} is unavailable or unsafe`); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || process.platform !== "win32" && stat.uid !== process.getuid()) fail(`${label} must be an owned regular file`);
    if (process.platform !== "win32" && mode && (stat.mode & 0o077) !== 0) fail(`${label} permissions must be private`);
    return stat;
  } finally { await handle.close(); }
};

export function parseJsonStrict(text, maxBytes = 1_048_576) {
  try { return parseStrictJsonText(text, { maxBytes, maxDepth: 64 }); }
  catch (error) { throw new Fault("input", error.message); }
}

function origin(value, label) {
  let url;
  try { url = new URL(str(value, label)); } catch { fail(`${label} is invalid`); }
  if (url.protocol !== "https:" || value.includes("@") || value.includes("?") || value.includes("#") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.hostname.includes("%")) fail(`${label} must be a fixed HTTPS origin`);
  return url.origin;
}

function pathValue(value, base, label) {
  const raw = str(value, label, 4096);
  const path = resolve(base, raw);
  if (Buffer.byteLength(path) > 4096) fail(`${label} is too long`);
  return path;
}

function validateLaunch(value) {
  if (value === null) return null;
  exact(value, ["runtime", "executable", "args", "cwd", "capabilities", "maxChildren", "readyTimeoutMs"], "pool.launch");
  const runtime = str(value.runtime, "launch.runtime", 32);
  if (!/^[A-Za-z0-9._-]+$/.test(runtime) || runtime === "prime") fail("launch.runtime is invalid");
  const executable = str(value.executable, "launch.executable");
  const cwd = str(value.cwd, "launch.cwd");
  if (!isAbsolute(executable) || !isAbsolute(cwd)) fail("launch paths must be absolute");
  if (!Array.isArray(value.args) || value.args.length > 32 || value.args.some((a) => typeof a !== "string" || Buffer.byteLength(a) > 1024 || a.includes("\0")) || value.args.reduce((n, a) => n + Buffer.byteLength(a), 0) > 8192) fail("launch.args is invalid");
  return Object.freeze({ runtime, executable, args: [...value.args], cwd, capabilities: tags(value.capabilities, "launch.capabilities"), maxChildren: int(value.maxChildren, "launch.maxChildren", 1, 16), readyTimeoutMs: int(value.readyTimeoutMs, "launch.readyTimeoutMs", 1000, 60000) });
}

export async function prepareLocalProfile(root, configFile) {
  const directory = dirname(resolve(configFile));
  const file = resolve(configFile);
  const tokenFile = join(directory, "viewer.token");
  const registryFile = join(directory, "credentials.json");
  const lockFile = join(directory, ".setup.lock");
  const exists = async (path) => {
    try { await lstat(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const reuse = async () => {
    const selected = await readConfig(file);
    if (selected.mode !== "local" || selected.role !== "host" || selected.hub || selected.pool || selected.delivery.enabled) {
      fail("Local startup requires a loopback host profile without agents; use explicit --root and --config for other profiles");
    }
    const { readToken } = await import("./client.mjs");
    const { authenticate, loadRegistry } = await import("./auth.mjs");
    const token = await readToken(tokenFile);
    authenticate(await loadRegistry(selected.credentialsFile), `Bearer ${token}`);
    return { tokenFile };
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) {
    throw new Fault("denied", "Local profile must be an owned private directory, not a symlink");
  }
  if (await exists(file)) return reuse();
  let lock;
  try { lock = await openFile(lockFile, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Fault("active", "Local profile initialization is locked; inspect .local/.setup.lock before retrying");
    throw error;
  }
  let staging, failure;
  const published = [];
  try {
    if (await exists(file)) return await reuse();
    if (await exists(tokenFile) || await exists(registryFile)) {
      throw new Fault("active", "Local credentials exist without a config; refusing to replace them");
    }
    const { open, setup } = await import("./relay.mjs");
    let device;
    if (await exists(root)) {
      const relay = open({ root, role: "host", readOnly: true });
      try { device = relay.device; } finally { relay.close(); }
    } else device = setup({ root, device: "relay-local", role: "host" });
    const token = randomBytes(32).toString("base64url");
    const board = `host:${device.id}`;
    const registry = { version: 1, credentials: [{ principal: "local-viewer", tokenDigest: createHash("sha256").update(token).digest("hex"), grant: {
      enroll: [], register: [], workers: [], recipients: [], boardPost: [], boardClaim: [],
      inboxRead: [board], workRead: [board],
      inspect: { messages: false, receipts: false, audit: false, topology: true }, reportDevice: null,
    } }] };
    const selected = { version: 1, role: "host", mode: "local", listen: { host: "127.0.0.1", port: 4200 },
      tls: null, allowedPeers: [], credentialsFile: "credentials.json", hub: null, pool: null, views: [] };
    staging = await mkdtemp(join(directory, ".setup-"));
    const files = [["viewer.token", tokenFile, `${token}\n`],
      ["credentials.json", registryFile, `${JSON.stringify(registry, null, 2)}\n`],
      ["relay.json", file, `${JSON.stringify(selected, null, 2)}\n`]];
    for (const [name, , contents] of files) await writeFile(join(staging, name), contents, { mode: 0o600, flag: "wx" });
    await readConfig(join(staging, "relay.json"));
    const { loadRegistry } = await import("./auth.mjs");
    await loadRegistry(join(staging, "credentials.json"));
    // Publish the config last so a second launcher cannot accept partial credentials.
    for (const [name, target] of files) {
      await link(join(staging, name), target);
      published.push(target);
    }
    return { tokenFile };
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = [];
    const cleanup = [
      ...(failure ? published.map((path) => () => unlink(path)) : []),
      () => staging && rm(staging, { recursive: true, force: true }),
      () => lock.close(), () => unlink(lockFile),
    ];
    for (const action of cleanup) { try { await action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, "Local profile cleanup failed", { cause: failure });
  }
}

export async function readConfig(configFile) {
  const file = resolve(str(configFile, "configFile"));
  let doc;
  try {
    const handle = await openFile(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || process.platform !== "win32" && stat.uid !== process.getuid()) fail("Config file must be an owned regular file");
      if (stat.size > 1_048_576) fail("Config file is too large");
      doc = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()), 1_048_576);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("unavailable", "Config file cannot be read");
  }
  if (!record(doc)) fail("Config must be an object");
  if (![1, 2].includes(doc.version)) fail("Config version is invalid");
  exact(doc, doc.version === 1
    ? ["version", "role", "mode", "listen", "tls", "allowedPeers", "credentialsFile", "hub", "pool", "views"]
    : ["version", "role", "mode", "listen", "tls", "allowedPeers", "credentialsFile", "hub", "pool", "views", "delivery"], "config");
  if (!["host", "hub"].includes(doc.role) || !["local", "lan", "tailscale"].includes(doc.mode)) fail("Config role or mode is invalid");
  const delivery = doc.version === 1 ? Object.freeze({ enabled: false, clients: Object.freeze([]), pollMs: LIMITS.deliveryPollMs }) : (() => {
    exact(doc.delivery, ["enabled", "clients", "pollMs"], "delivery");
    if (typeof doc.delivery.enabled !== "boolean") fail("delivery.enabled is invalid");
    if (!Array.isArray(doc.delivery.clients) || doc.delivery.clients.length > DELIVERY_CLIENTS.length || new Set(doc.delivery.clients).size !== doc.delivery.clients.length || doc.delivery.clients.some((client) => !DELIVERY_CLIENTS.includes(client))) fail("delivery.clients is invalid");
    const clients = Object.freeze([...doc.delivery.clients]);
    const pollMs = int(doc.delivery.pollMs, "delivery.pollMs", LIMITS.deliveryPollMinMs, LIMITS.deliveryPollMaxMs);
    if (doc.delivery.enabled && (doc.role !== "host" || clients.length === 0)) fail("Enabled delivery requires a host and at least one client");
    if (!doc.delivery.enabled && clients.length !== 0) fail("Disabled delivery requires an empty client selection");
    return Object.freeze({ enabled: doc.delivery.enabled, clients, pollMs });
  })();
  exact(doc.listen, ["host", "port"], "listen");
  const host = str(doc.listen.host, "listen.host", 64);
  const family = isIP(host);
  if (!family || host.includes("%")) fail("listen.host must be a literal IP address");
  const loopback = host === "127.0.0.1" || host === "::1";
  if ((doc.mode === "lan") === loopback || (doc.mode !== "lan" && !loopback)) fail("listen address does not match mode");
  if (doc.mode === "lan" && (!family || host === "0.0.0.0" || host === "::" || host.startsWith("224.") || host.toLowerCase().startsWith("ff"))) fail("LAN listener must be a unicast address");
  const port = int(doc.listen.port, "listen.port", 1, 65535);
  let tls = null;
  if (doc.mode === "lan") {
    exact(doc.tls, ["certFile", "keyFile"], "tls");
    tls = Object.freeze({ certFile: pathValue(doc.tls.certFile, dirname(file), "tls.certFile"), keyFile: pathValue(doc.tls.keyFile, dirname(file), "tls.keyFile") });
    await privateFile(tls.certFile, "TLS certificate"); await privateFile(tls.keyFile, "TLS private key", { mode: true });
  } else if (doc.tls !== null) fail("TLS files are only valid in LAN mode");
  if (!Array.isArray(doc.allowedPeers) || doc.allowedPeers.length > 256 || new Set(doc.allowedPeers).size !== doc.allowedPeers.length) fail("allowedPeers is invalid");
  const allowedPeers = doc.allowedPeers.map((v) => {
    const ip = str(v, "allowed peer", 64);
    if (!isIP(ip) || ip.includes("%") || ip === "0.0.0.0" || ip === "::") fail("allowed peer must be a canonical IP");
    return ip;
  });
  if ((doc.mode === "lan") !== (allowedPeers.length > 0)) fail("LAN mode requires exact allowed peers");
  const credentialsFile = pathValue(doc.credentialsFile, dirname(file), "credentialsFile");
  const hub = doc.hub === null ? null : (() => {
    if (doc.role !== "host") fail("Only a host may configure hub");
    exactOptional(doc.hub, ["url", "tokenFile"], ["caFile"], "hub");
    const result = { url: origin(doc.hub.url, "hub.url"), tokenFile: pathValue(doc.hub.tokenFile, dirname(file), "hub.tokenFile"), caFile: doc.hub.caFile === undefined ? undefined : pathValue(doc.hub.caFile, dirname(file), "hub.caFile") };
    return Object.freeze(result);
  })();
  let pool = null;
  if (doc.pool !== null) {
    if (doc.role !== "host") fail("Hub configuration cannot start a pool");
    exact(doc.pool, ["maxAgents", "maxJobs", "pollMs", "minBackoffMs", "maxBackoffMs", "launch"], "pool");
    const minBackoffMs = int(doc.pool.minBackoffMs, "pool.minBackoffMs", 100, 5000);
    const maxBackoffMs = int(doc.pool.maxBackoffMs, "pool.maxBackoffMs", minBackoffMs, 60000);
    pool = Object.freeze({ maxAgents: int(doc.pool.maxAgents, "pool.maxAgents", 1, 512), maxJobs: int(doc.pool.maxJobs, "pool.maxJobs", 1, 128), pollMs: int(doc.pool.pollMs, "pool.pollMs", 100, 60000), minBackoffMs, maxBackoffMs, launch: validateLaunch(doc.pool.launch) });
  }
  if (doc.role === "hub" && doc.pool !== null) fail("Hub pool must be null");
  if (!Array.isArray(doc.views) || doc.views.length > 64) fail("views is invalid");
  const viewIds = new Set();
  const views = doc.views.map((view) => {
    exactOptional(view, ["deviceId", "url", "tokenFile", "boards"], ["caFile"], "view");
    const deviceId = str(view.deviceId, "view.deviceId", 128);
    if (viewIds.has(deviceId)) fail("duplicate view deviceId"); viewIds.add(deviceId);
    if (!Array.isArray(view.boards) || !view.boards.length || view.boards.length > 64 || new Set(view.boards).size !== view.boards.length || view.boards.some((b) => typeof b !== "string" || !/^host:[A-Za-z0-9._-]{1,128}$/.test(b))) fail("view.boards is invalid");
    return Object.freeze({ deviceId, url: origin(view.url, "view.url"), tokenFile: pathValue(view.tokenFile, dirname(file), "view.tokenFile"), caFile: view.caFile === undefined ? undefined : pathValue(view.caFile, dirname(file), "view.caFile"), boards: [...view.boards] });
  });
  await privateFile(credentialsFile, "credential registry", { mode: true });
  return Object.freeze({ version: doc.version, role: doc.role, mode: doc.mode, listen: Object.freeze({ host, port }), tls, allowedPeers: Object.freeze(allowedPeers), credentialsFile, hub, pool, views: Object.freeze(views), delivery, directory: dirname(file) });
}
