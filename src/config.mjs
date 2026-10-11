import { isIP } from "node:net";
import { open as openFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Fault } from "./fault.mjs";
import { DELIVERY_CLIENTS, LIMITS } from "./validate.mjs";

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
  try { handle = await openFile(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch { throw new Fault("unavailable", `${label} is unavailable or unsafe`); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || process.platform !== "win32" && stat.uid !== process.getuid()) fail(`${label} must be an owned regular file`);
    if (process.platform !== "win32" && mode && (stat.mode & 0o077) !== 0) fail(`${label} permissions must be private`);
    return stat;
  } finally { await handle.close(); }
};

// JSON.parse silently accepts duplicate object keys. This bounded recursive parser
// rejects them before either security-sensitive document is interpreted.
export function parseJsonStrict(text, maxBytes = 1_048_576) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) fail("JSON document is too large");
  let i = 0;
  const ws = () => { while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      const c = text.charCodeAt(i++);
      if (c === 34) {
        try { return JSON.parse(text.slice(start, i)); } catch { fail("JSON string is invalid"); }
      }
      if (c < 0x20) fail("JSON string contains a control character");
      if (c === 92) {
        if (i >= text.length) fail("JSON escape is incomplete");
        const e = text[i++];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) fail("JSON unicode escape is invalid");
          i += 4;
        } else if (!'"\\/bfnrt'.includes(e)) fail("JSON escape is invalid");
      }
    }
    fail("JSON string is incomplete");
  };
  const value = (depth) => {
    if (depth > 64) fail("JSON nesting is too deep");
    ws();
    const c = text[i];
    if (c === '"') return string();
    if (c === "{") {
      i++; ws(); const out = {};
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("JSON object key is invalid");
        const key = string(); if (Object.hasOwn(out, key)) fail("JSON object has a duplicate key");
        ws(); if (text[i++] !== ":") fail("JSON object separator is invalid");
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); ws();
        if (text[i] === "}") { i++; return out; }
        if (text[i++] !== ",") fail("JSON object separator is invalid");
      }
    }
    if (c === "[") {
      i++; ws(); const out = [];
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value(depth + 1)); ws();
        if (text[i] === "]") { i++; return out; }
        if (text[i++] !== ",") fail("JSON array separator is invalid");
      }
    }
    const rest = text.slice(i);
    for (const [literal, result] of [["true", true], ["false", false], ["null", null]]) {
      if (rest.startsWith(literal)) { i += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (match) {
      i += match[0].length; const n = Number(match[0]);
      if (!Number.isFinite(n)) fail("JSON number is not finite");
      return n;
    }
    fail("JSON value is invalid");
  };
  const result = value(0); ws();
  if (i !== text.length) fail("JSON has trailing data");
  return result;
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

export async function readConfig(configFile) {
  const file = resolve(str(configFile, "configFile"));
  let doc;
  try {
    const handle = await openFile(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || process.platform !== "win32" && stat.uid !== process.getuid()) fail("input", "Config file must be owned by the current user");
      if (stat.size > 1_048_576) fail("input", "Config file is too large");
      doc = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()), 1_048_576);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("unavailable", "Config file cannot be read");
  }
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
