#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { spawn } from "node:child_process";
import { parseStrictJsonText } from "./strict-json.mjs";

const route = {
  setup: { positionals: 0, flags: { root: "one", device: "one", role: "one", json: "bool" }, local: true },
  register: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", slot: "one", cap: "many", json: "bool" } },
  enroll: { positionals: 0, flags: { root: "one", config: "one", json: "bool" }, local: true },
  join: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", replace: "bool", json: "bool" } },
  resume: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", json: "bool" } },
  renew: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", json: "bool" } },
  leave: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", json: "bool" } },
  send: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", key: "one", json: "bool" } },
  post: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", need: "many", series: "one", key: "one", json: "bool" } },
  claim: { positionals: 0, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", board: "one", kind: "one", json: "bool" } },
  touch: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", json: "bool" } },
  ack: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", outcome: "one", json: "bool" } },
  release: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", json: "bool" } },
  get: { positionals: 1, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", data: "bool", json: "bool" }, readOnly: true },
  list: { positionals: 0, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", to: "one", board: "one", kind: "one", state: "one", data: "bool", json: "bool" }, readOnly: true },
  stats: { positionals: 0, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", json: "bool" }, readOnly: true },
  audit: { positionals: 0, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", after: "one", json: "bool" }, readOnly: true },
  snapshot: { positionals: 0, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", device: "one", limit: "one", after: "one", json: "bool" }, readOnly: true },
  pending: { positionals: 0, flags: { root: "one", url: "one", "token-file": "one", "ca-file": "one", mode: "one", sid: "one", json: "bool" }, readOnly: true },
  purge: { positionals: 0, flags: { root: "one", before: "one", dry: "bool", json: "bool" }, local: true },
  serve: { positionals: 0, flags: { root: "one", config: "one", json: "bool", "no-copy-token": "bool" }, local: true },
  migrate: { positionals: 0, flags: { root: "one", to: "one", backup: "one", config: "one", json: "bool" }, local: true },
  "delivery-status": { positionals: 0, flags: { root: "one", config: "one", json: "bool" }, local: true, readOnly: true },
  "delivery-reconcile": { positionals: 1, flags: { root: "one", outcome: "one", "reason-code": "one", confirm: "bool", json: "bool" }, local: true },
};

export class CliInputError extends Error {
  constructor(message) { super(message); this.name = "CliInputError"; }
}

export function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") return { help: true };
  const spec = route[command];
  if (!spec) throw new CliInputError(`unknown command: ${command}`);
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") throw new CliInputError("-- is not supported");
    if (!arg.startsWith("--")) {
      if (arg.includes("\0")) throw new CliInputError("positional values must not contain NUL");
      positional.push(arg);
      continue;
    }
    const split = arg.indexOf("=");
    const name = arg.slice(2, split < 0 ? undefined : split);
    const kind = spec.flags[name];
    if (!kind) throw new CliInputError(`unknown option: --${name}`);
    if (kind === "bool") {
      if (split >= 0) throw new CliInputError(`--${name} does not take a value`);
      if (Object.hasOwn(flags, name)) throw new CliInputError(`duplicate option: --${name}`);
      flags[name] = true;
      continue;
    }
    let value;
    if (split >= 0) value = arg.slice(split + 1);
    else {
      value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new CliInputError(`--${name} requires a value`);
    }
    if (!value || value.includes("\0")) throw new CliInputError(`invalid value for --${name}`);
    if (kind === "many") (flags[name] ??= []).push(value);
    else {
      if (Object.hasOwn(flags, name)) throw new CliInputError(`duplicate option: --${name}`);
      flags[name] = value;
    }
  }
  if (positional.length !== spec.positionals) throw new CliInputError(`${command} expects ${spec.positionals} positional argument(s)`);
  if (flags.role && !["host", "hub"].includes(flags.role)) throw new CliInputError("--role must be host or hub");
  if (command === "setup" && flags.role === "hub" && !flags.device) throw new CliInputError("hub setup requires --device");
  if (flags.kind && !["msg", "work"].includes(flags.kind)) throw new CliInputError("--kind must be msg or work");
  if (command === "ack" && flags.outcome && !["done", "failed", "rejected"].includes(flags.outcome)) throw new CliInputError("--outcome must be done, failed, or rejected");
  if (flags.state && !["pending", "claimed", "posted", "done", "failed", "rejected"].includes(flags.state)) throw new CliInputError("invalid --state");
  if (command === "delivery-reconcile" && (!flags.confirm || !["observed", "not-accepted"].includes(flags.outcome) || flags["reason-code"] !== "operator-confirmed")) throw new CliInputError("delivery reconciliation requires --outcome observed|not-accepted --reason-code operator-confirmed --confirm");
  if (command === "migrate" && (!flags.to || !["2", "3"].includes(flags.to) || !flags.backup || flags.to === "2" && !flags.config || flags.to === "3" && flags.config)) throw new CliInputError("migrate requires --to 3 --backup PATH, or --to 2 --backup PATH --config FILE with delivery disabled");
  for (const name of ["cap", "need"]) {
    const values = flags[name] ?? [];
    if (values.length > 16 || new Set(values).size !== values.length) throw new CliInputError(`--${name} accepts at most 16 unique values`);
  }
  if (flags.limit && (!/^[1-9]\d*$/.test(flags.limit) || Number(flags.limit) > 512)) throw new CliInputError("--limit must be an integer from 1 to 512");
  if (flags.before && !/^(0|[1-9]\d*)$/.test(flags.before)) throw new CliInputError("--before must be a non-negative epoch-millisecond integer");
  if (flags.before && !Number.isSafeInteger(Number(flags.before))) throw new CliInputError("--before is outside the safe integer range");
  if (command === "list" && flags.to && flags.board) throw new CliInputError("--to and --board are mutually exclusive");
  if (command === "claim" && flags.board && flags.kind === "msg") throw new CliInputError("board claims accept work only");

  const defaultLocal = command === "serve" && flags.root === undefined && flags.config === undefined;
  if (defaultLocal) {
    flags.root = ".local/store";
    flags.config = ".local/relay.json";
  }
  const hasRoot = flags.root !== undefined;
  const hasUrl = flags.url !== undefined;
  if (hasRoot && hasUrl) throw new CliInputError("--root and --url are mutually exclusive");
  if (spec.local && (hasUrl || flags["token-file"] || flags["ca-file"] || flags.mode)) throw new CliInputError(`${command} is local-only`);
  if (command === "setup" && !hasRoot) throw new CliInputError("setup requires --root");
  if (command === "enroll" && (!hasRoot || !flags.config)) throw new CliInputError("enroll requires --root and --config");
  if (command === "serve" && (!hasRoot || !flags.config)) throw new CliInputError("serve requires --root and --config");
  if (command === "delivery-status" && !flags.config) throw new CliInputError("delivery-status requires --root and --config");
  if (command === "purge" && (!hasRoot || !flags.before)) throw new CliInputError("purge requires --root and --before");
  if (hasUrl) {
    if (!flags["token-file"]) throw new CliInputError("remote commands require --token-file");
    let endpoint;
    try { endpoint = new URL(flags.url); } catch { throw new CliInputError("--url must be a valid HTTP(S) origin"); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new CliInputError("--url must not contain credentials, a path, query, or fragment");
    if (endpoint.protocol === "http:") {
      const literalLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
      if (flags.mode !== "local" || !literalLoopback) throw new CliInputError("HTTP requires --mode local and a literal loopback URL");
    } else if (endpoint.protocol !== "https:") throw new CliInputError("--url must use HTTPS");
    else if (flags.mode) throw new CliInputError("--mode is only valid for HTTP local mode");
  } else {
    if (!hasRoot) throw new CliInputError(`${command} requires --root or --url`);
    if (flags["token-file"] || flags["ca-file"] || flags.mode) throw new CliInputError("remote options require --url");
  }
  if (flags["ca-file"] && flags.mode === "local") throw new CliInputError("--ca-file is not used in HTTP local mode");
  if (command === "register" && hasUrl && !flags.slot) throw new CliInputError("remote registration requires --slot");
  if (command === "send" || command === "post") required(flags, "sid");
  if (command === "pending") required(flags, "sid");
  if (["claim", "touch", "ack", "release"].includes(command)) required(flags, "sid");
  if (command === "ack") required(flags, "outcome");
  return { command, positional, flags, readOnly: Boolean(spec.readOnly), help: false, defaultLocal };
}

function required(flags, key) {
  if (!flags[key]) throw new CliInputError(`--${key} is required`);
}

const helpText = `Relay\n\nCommands: setup register enroll join resume renew leave send post claim touch ack release get list pending stats audit snapshot purge migrate serve delivery-status delivery-reconcile\n\nLocal routes use --root PATH. Bare serve (npm start) initializes/reuses the private .local/ host profile on loopback port 4200 and prints its URL and viewer token-file path. Local startup also attempts a Wayland clipboard copy using optional wl-copy; --no-copy-token or --json skips copying. Custom serve profiles require both --root PATH and --config FILE and never touch the clipboard. Remote routes use --url HTTPS_ORIGIN --token-file FILE, with optional --ca-file FILE. HTTP requires --mode local and a literal loopback URL. Use delivery-status --root PATH --config FILE for read-only redacted diagnostics. Reconciliation requires --confirm and --reason-code operator-confirmed while the broker is stopped. Migration requires an unused backup path; rollback to v2 requires --config FILE with delivery disabled. Use --json for exact JSON output.\n`;

export async function readEnvelope(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_537) throw new CliInputError("stdin envelope exceeds 65,536 bytes plus framing");
    chunks.push(bytes);
  }
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new CliInputError("stdin is not valid UTF-8"); }
  const value = parseStrictJson(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliInputError("stdin must contain one envelope object");
  if (containsNul(value)) throw new CliInputError("stdin envelope values must not contain NUL");
  const keys = Object.keys(value);
  if (keys.length !== 1 || !["msg", "work"].includes(keys[0])) throw new CliInputError("envelope must contain exactly one msg or work key");
  if (keys[0] === "msg" && (typeof value.msg !== "string" || value.msg.length === 0)) throw new CliInputError("msg must be a nonempty string");
  return value;
}

function containsNul(value) {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => key.includes("\0") || containsNul(item));
  return false;
}

export function parseStrictJson(source) {
  try { return parseStrictJsonText(source, { maxBytes: 65_537, maxDepth: 128 }); }
  catch { throw new CliInputError("stdin must contain one strict JSON value without duplicate object keys"); }
}

export async function main(argv = process.argv.slice(2), io = process) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { return reportError(error, argv.includes("--json"), io); }
  if (parsed.help) { io.stdout.write(helpText); return 0; }
  const { command, positional, flags } = parsed;
  let envelope;
  try {
    if (command === "send" || command === "post") {
      envelope = await readEnvelope(io.stdin);
      if (command === "post" && envelope.msg && (flags.need?.length || flags.series !== undefined)) throw new CliInputError("--need and --series require a {work: ...} envelope");
    }
  } catch (error) { return reportError(error, Boolean(flags.json), io); }

  let handle;
  try {
    const api = await import("./index.mjs");
    if (command === "setup") {
      const result = api.setup({ root: flags.root, ...(flags.device ? { device: flags.device } : {}), ...(flags.role ? { role: flags.role } : {}) });
      return output(result, flags.json, command, io);
    }
    if (command === "enroll") {
      const { readConfig } = await import("./config.mjs");
      const cfg = await readConfig(flags.config);
      if (!cfg.hub) throw new CliInputError("config has no fixed hub binding");
      const local = api.open({ root: flags.root, readOnly: true });
      try {
        const client = await api.connect({ url: cfg.hub.url, tokenFile: cfg.hub.tokenFile, ...(cfg.hub.caFile ? { caFile: cfg.hub.caFile } : {}) });
        try { return output(await client.enroll(local.device), flags.json, command, io); }
        finally { await client.close(); }
      } finally { local.close(); }
    }
    if (command === "serve") {
      let profile;
      if (parsed.defaultLocal) {
        const { prepareLocalProfile } = await import("./config.mjs");
        profile = await prepareLocalProfile(flags.root, flags.config);
      }
      return await serve(api, flags, io, profile);
    }
    if (command === "migrate") {
      const { migrateLocalStore } = await import("./broker.mjs");
      const result = await migrateLocalStore({ root: flags.root, to: Number(flags.to), backup: flags.backup, ...(flags.config ? { configFile: flags.config } : {}) });
      return output(result, flags.json, command, io);
    }
    if (command === "delivery-status") {
      const [{ readConfig }, { deliveryStatus }, { inspectDeliveryAdapters }] = await Promise.all([import("./config.mjs"), import("./relay.mjs"), import("./delivery.mjs")]);
      const config = await readConfig(flags.config);
      handle = api.open({ root: flags.root, readOnly: true });
      const core = deliveryStatus(handle);
      const clients = await inspectDeliveryAdapters(config.delivery.clients);
      return output(Object.freeze({ configuredEnabled: config.delivery.enabled, pollMs: config.delivery.pollMs, clients, ...core }), flags.json, command, io);
    }
    if (command === "delivery-reconcile") {
      const { reconcileLocalDelivery } = await import("./broker.mjs");
      const result = await reconcileLocalDelivery({ root: flags.root, id: positional[0], outcome: flags.outcome, confirm: flags.confirm, reasonCode: flags["reason-code"] });
      return output(result, flags.json, command, io);
    }
    if (command === "purge") {
      handle = api.open({ root: flags.root });
      return output(handle.purge({ before: Number(flags.before), ...(flags.dry ? { dry: true } : {}) }), flags.json, command, io);
    }

    const remote = flags.url !== undefined;
    handle = remote
      ? await api.connect({ url: flags.url, tokenFile: flags["token-file"], ...(flags["ca-file"] ? { caFile: flags["ca-file"] } : {}), ...(flags.mode ? { mode: flags.mode } : {}) })
      : api.open({ root: flags.root, ...(parsed.readOnly ? { readOnly: true } : {}) });
    const method = methodArgs(command, positional, flags, envelope);
    const result = await handle[command](...method);
    return output(result, flags.json, command, io);
  } catch (error) {
    return reportError(error, Boolean(flags.json), io);
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch (error) {
        io.stderr.write(`cleanup: resource close failed (${safeText(error?.code ?? "runtime")})\n`);
        io.exitCode = Math.max(io.exitCode ?? 0, 1);
      }
    }
  }
}

function methodArgs(command, positional, flags, envelope) {
  const one = positional[0];
  const keyOptions = flags.key ? { key: flags.key } : {};
  switch (command) {
    case "register": return [one, { ...(flags.slot ? { slot: flags.slot } : {}), ...(flags.cap ? { caps: flags.cap } : {}) }];
    case "join": return [one, flags.replace ? { replace: true } : {}];
    case "resume": case "renew": case "leave": return [one];
    case "send": return [flags.sid, one, envelope, keyOptions];
    case "post": return [flags.sid, one, envelope, { ...keyOptions, ...(flags.need ? { needs: flags.need } : {}), ...(flags.series ? { series: flags.series } : {}) }];
    case "claim": return [flags.sid, { ...(flags.board ? { board: flags.board } : {}), ...(flags.kind ? { kind: flags.kind } : {}) }];
    case "touch": case "release": return [flags.sid, one];
    case "ack": return [flags.sid, one, flags.outcome];
    case "get": return [one, flags.data ? { data: true } : {}];
    case "list": return [{ ...pick(flags, ["to", "board", "kind", "state"]), ...(flags.data ? { data: true } : {}) }];
    case "stats": return [];
    case "pending": return [flags.sid];
    case "audit": return [pick(flags, ["after"])];
    case "snapshot": return [{ ...pick(flags, ["device", "after"]), ...(flags.limit ? { limit: Number(flags.limit) } : {}) }];
    default: throw new CliInputError(`command is not implemented: ${command}`);
  }
}

function pick(source, keys) { return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])); }

export async function copyViewerToken(tokenFile, { env = process.env, signal } = {}) {
  if (!env.WAYLAND_DISPLAY || !env.XDG_RUNTIME_DIR || signal?.aborted) return false;
  const { readToken } = await import("./client.mjs");
  let token;
  try { token = await readToken(tokenFile); } catch { return false; }
  if (signal?.aborted) return false;
  return new Promise((resolveCopy) => {
    const child = spawn("wl-copy", ["--type", "text/plain", "--sensitive"], {
      env, shell: false, stdio: ["pipe", "ignore", "ignore"],
    });
    let failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 2_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", () => { failed = true; });
    child.stdin?.on("error", () => { failed = true; });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolveCopy(!failed && code === 0 && !signal?.aborted);
    });
    child.stdin?.end(token);
  });
}

async function serve(api, flags, io, profile) {
  const broker = await api.serve({ root: flags.root, configFile: flags.config });
  const clipboardController = new AbortController();
  let requestStop;
  const stopped = new Promise((resolveStop) => { requestStop = () => { clipboardController.abort(); resolveStop(); }; });
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    const address = broker.address;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    const info = { address, ...(profile ? { url: `http://${host}:${address.port}`, tokenFile: profile.tokenFile } : {}) };
    if (flags.json) io.stdout.write(`${JSON.stringify(info)}\n`);
    else io.stdout.write(`${profile ? `Relay: ${info.url}\nViewer token file: ${safeText(profile.tokenFile)}` : `Listening: ${host}:${address.port}`}\n`);
    if (profile && !flags.json && !flags["no-copy-token"]) {
      const copied = await copyViewerToken(profile.tokenFile, { signal: clipboardController.signal });
      if (!clipboardController.signal.aborted) io.stdout.write(copied
        ? "Viewer token copied to clipboard. Paste it into Bearer token, then Connect.\n"
        : "Clipboard unavailable. Copy the viewer token from the file above.\n");
    }
    await stopped;
    return 0;
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await broker.close();
  }
}

function output(value, json, command, io) {
  if (json) io.stdout.write(`${JSON.stringify(value)}\n`);
  else if (command === "register") io.stdout.write(`${safeText(value.id)}\n`);
  else io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function safeText(value) { return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?"); }
const faultCodes = new Set(["input", "data", "missing", "schema", "active", "session", "expired", "target", "device_conflict", "board", "key_conflict", "ack_conflict", "owner", "lease", "full", "busy", "clock", "storage", "auth", "denied", "protocol", "tls", "rpc_conflict", "uncertain", "cursor", "reset", "rate", "timeout", "unavailable"]);
function reportError(error, json, io) {
  const knownFault = faultCodes.has(error?.code);
  const code = error instanceof CliInputError || ["input", "data", "protocol"].includes(error?.code) ? 2
    : knownFault && error.code !== "storage" ? 3 : 1;
  const label = knownFault ? String(error.code) : code === 2 ? "input" : "runtime";
  const message = error instanceof CliInputError || knownFault ? safeText(error?.message ?? error) : "storage/runtime failure";
  const record = { error: { code: label, message } };
  io.stderr.write(json ? `${JSON.stringify(record)}\n` : `${record.error.code}: ${record.error.message}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = Math.max(await main(), process.exitCode ?? 0);
}
