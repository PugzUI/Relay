#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { parseStrictJsonText } from "./strict-json.mjs";

const route = {
  setup: {
    positionals: 0,
    flags: { root: "one", device: "one", role: "one", json: "bool" },
    local: true,
  },
  register: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      slot: "one",
      cap: "many",
      json: "bool",
    },
  },
  enroll: { positionals: 0, flags: { root: "one", config: "one", json: "bool" }, local: true },
  join: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      replace: "bool",
      json: "bool",
    },
  },
  resume: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      json: "bool",
    },
  },
  renew: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      json: "bool",
    },
  },
  leave: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      json: "bool",
    },
  },
  send: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      key: "one",
      json: "bool",
    },
  },
  post: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      need: "many",
      series: "one",
      key: "one",
      json: "bool",
    },
  },
  claim: {
    positionals: 0,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      board: "one",
      kind: "one",
      json: "bool",
    },
  },
  touch: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      json: "bool",
    },
  },
  ack: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      outcome: "one",
      json: "bool",
    },
  },
  release: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      json: "bool",
    },
  },
  get: {
    positionals: 1,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      data: "bool",
      json: "bool",
    },
    readOnly: true,
  },
  list: {
    positionals: 0,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      to: "one",
      board: "one",
      kind: "one",
      state: "one",
      data: "bool",
      json: "bool",
    },
    readOnly: true,
  },
  stats: {
    positionals: 0,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      json: "bool",
    },
    readOnly: true,
  },
  audit: {
    positionals: 0,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      after: "one",
      json: "bool",
    },
    readOnly: true,
  },
  snapshot: {
    positionals: 0,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      device: "one",
      limit: "one",
      after: "one",
      json: "bool",
    },
    readOnly: true,
  },
  pending: {
    positionals: 0,
    flags: {
      root: "one",
      url: "one",
      "token-file": "one",
      "ca-file": "one",
      mode: "one",
      sid: "one",
      json: "bool",
    },
    readOnly: true,
  },
  purge: {
    positionals: 0,
    flags: { root: "one", before: "one", dry: "bool", json: "bool" },
    local: true,
  },
  serve: {
    positionals: 0,
    flags: { root: "one", config: "one", json: "bool", "no-copy-token": "bool" },
    local: true,
  },
  migrate: {
    positionals: 0,
    flags: { root: "one", to: "one", backup: "one", config: "one", json: "bool" },
    local: true,
  },
  "delivery-status": {
    positionals: 0,
    flags: { root: "one", config: "one", json: "bool" },
    local: true,
    readOnly: true,
  },
  "delivery-reconcile": {
    positionals: 1,
    flags: { root: "one", outcome: "one", "reason-code": "one", confirm: "bool", json: "bool" },
    local: true,
  },
};

export class CliInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliInputError";
  }
}

export function loadDotEnv(path = ".env", env = process.env) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || Object.hasOwn(env, match[1])) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, "$2");
  }
  return true;
}

export function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") return { help: true };
  const spec = route[command];
  if (!spec) throw new CliInputError(`unknown command: ${command}`);
  const { flags, positional } = parseOptions(args, spec);
  if (positional.length !== spec.positionals) {
    throw new CliInputError(`${command} expects ${spec.positionals} positional argument(s)`);
  }
  for (const validate of flagValidators) validate(command, flags);
  const defaultLocal =
    command === "serve" && flags.root === undefined && flags.config === undefined;
  if (defaultLocal) {
    flags.root = ".local/store";
    flags.config = ".local/relay.json";
  }
  validateRoute(command, flags, spec);
  validateRequiredFlags(command, flags);
  return {
    command,
    positional,
    flags,
    readOnly: Boolean(spec.readOnly),
    help: false,
    defaultLocal,
  };
}

function parseOptions(args, spec) {
  const flags = Object.create(null);
  const positional = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    index += 1;
    if (arg === "--") throw new CliInputError("-- is not supported");
    if (!arg.startsWith("--")) {
      positional.push(readPositional(arg));
      continue;
    }
    const option = describeOption(arg, spec);
    if (option.kind === "bool") {
      readBooleanOption(flags, option);
      continue;
    }
    const read = readOptionValue(args, option, index);
    index = read.nextIndex;
    readValueOption(flags, option, read.value);
  }
  return { flags, positional };
}

function describeOption(arg, spec) {
  const split = arg.indexOf("=");
  const name = arg.slice(2, split < 0 ? undefined : split);
  const kind = spec.flags[name];
  if (!kind) throw new CliInputError(`unknown option: --${name}`);
  return { arg, name, kind, split };
}

function readPositional(arg) {
  if (arg.includes("\0")) throw new CliInputError("positional values must not contain NUL");
  return arg;
}

function readBooleanOption(flags, option) {
  if (option.split >= 0) throw new CliInputError(`--${option.name} does not take a value`);
  if (Object.hasOwn(flags, option.name)) {
    throw new CliInputError(`duplicate option: --${option.name}`);
  }
  flags[option.name] = true;
}

function readOptionValue(args, option, index) {
  if (option.split >= 0) return { value: option.arg.slice(option.split + 1), nextIndex: index };
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CliInputError(`--${option.name} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function readValueOption(flags, option, value) {
  if (!value || value.includes("\0")) {
    throw new CliInputError(`invalid value for --${option.name}`);
  }
  if (option.kind === "many") {
    const values = flags[option.name] ?? [];
    values.push(value);
    flags[option.name] = values;
    return;
  }
  if (Object.hasOwn(flags, option.name)) {
    throw new CliInputError(`duplicate option: --${option.name}`);
  }
  flags[option.name] = value;
}

const flagValidators = [
  validateRoleFlag,
  validateSetupRole,
  validateKindFlag,
  validateAckOutcome,
  validateStateFlag,
  validateReconcileFlags,
  validateMigrateFlags,
  validateRepeatedFlags,
  validateLimitFlag,
  validateBeforeFlag,
  validateListSelection,
  validateClaimSelection,
];

function validateRoleFlag(_command, flags) {
  if (flags.role && !["host", "hub"].includes(flags.role)) {
    throw new CliInputError("--role must be host or hub");
  }
}

function validateSetupRole(command, flags) {
  if (command === "setup" && flags.role === "hub" && !flags.device) {
    throw new CliInputError("hub setup requires --device");
  }
}

function validateKindFlag(_command, flags) {
  if (flags.kind && !["msg", "work"].includes(flags.kind)) {
    throw new CliInputError("--kind must be msg or work");
  }
}

function validateAckOutcome(command, flags) {
  if (
    command === "ack" &&
    flags.outcome &&
    !["done", "failed", "rejected"].includes(flags.outcome)
  ) {
    throw new CliInputError("--outcome must be done, failed, or rejected");
  }
}

function validateStateFlag(_command, flags) {
  const states = ["pending", "claimed", "posted", "done", "failed", "rejected"];
  if (flags.state && !states.includes(flags.state)) throw new CliInputError("invalid --state");
}

function validateReconcileFlags(command, flags) {
  if (command !== "delivery-reconcile") return;
  const outcomes = ["observed", "not-accepted"];
  if (
    !flags.confirm ||
    !outcomes.includes(flags.outcome) ||
    flags["reason-code"] !== "operator-confirmed"
  ) {
    throw new CliInputError(
      "delivery reconciliation requires --outcome observed|not-accepted --reason-code operator-confirmed --confirm",
    );
  }
}

function validateMigrateFlags(command, flags) {
  if (command !== "migrate") return;
  const invalid =
    !flags.to ||
    !["2", "3"].includes(flags.to) ||
    !flags.backup ||
    (flags.to === "2" && !flags.config) ||
    (flags.to === "3" && flags.config);
  if (invalid) {
    throw new CliInputError(
      "migrate requires --to 3 --backup PATH, or --to 2 --backup PATH --config FILE with delivery disabled",
    );
  }
}

function validateRepeatedFlags(_command, flags) {
  for (const name of ["cap", "need"]) {
    const values = flags[name] ?? [];
    if (values.length > 16 || new Set(values).size !== values.length) {
      throw new CliInputError(`--${name} accepts at most 16 unique values`);
    }
  }
}

function validateLimitFlag(_command, flags) {
  if (flags.limit && (!/^[1-9]\d*$/.test(flags.limit) || Number(flags.limit) > 512)) {
    throw new CliInputError("--limit must be an integer from 1 to 512");
  }
}

function validateBeforeFlag(_command, flags) {
  if (flags.before === undefined) return;
  if (!/^(0|[1-9]\d*)$/.test(flags.before)) {
    throw new CliInputError("--before must be a non-negative epoch-millisecond integer");
  }
  if (!Number.isSafeInteger(Number(flags.before))) {
    throw new CliInputError("--before is outside the safe integer range");
  }
}

function validateListSelection(command, flags) {
  if (command === "list" && flags.to && flags.board) {
    throw new CliInputError("--to and --board are mutually exclusive");
  }
}

function validateClaimSelection(command, flags) {
  if (command === "claim" && flags.board && flags.kind === "msg") {
    throw new CliInputError("board claims accept work only");
  }
}

const localRequirements = {
  setup: { keys: ["root"], message: "setup requires --root" },
  enroll: { keys: ["root", "config"], message: "enroll requires --root and --config" },
  serve: { keys: ["root", "config"], message: "serve requires --root and --config" },
  "delivery-status": { keys: ["config"], message: "delivery-status requires --root and --config" },
  purge: { keys: ["root", "before"], message: "purge requires --root and --before" },
};

function validateRoute(command, flags, spec) {
  const hasRoot = flags.root !== undefined;
  const hasUrl = flags.url !== undefined;
  if (hasRoot && hasUrl) throw new CliInputError("--root and --url are mutually exclusive");
  if (spec.local && (hasUrl || flags["token-file"] || flags["ca-file"] || flags.mode)) {
    throw new CliInputError(`${command} is local-only`);
  }
  validateLocalRequirements(command, flags);
  validateEndpoint(command, flags);
  if (flags["ca-file"] && flags.mode === "local") {
    throw new CliInputError("--ca-file is not used in HTTP local mode");
  }
  if (command === "register" && hasUrl && !flags.slot) {
    throw new CliInputError("remote registration requires --slot");
  }
}

function validateLocalRequirements(command, flags) {
  const requirement = localRequirements[command];
  if (!requirement) return;
  for (const key of requirement.keys) {
    if (flags[key] === undefined) throw new CliInputError(requirement.message);
  }
}

function validateEndpoint(command, flags) {
  const hasRoot = flags.root !== undefined;
  if (flags.url === undefined) {
    if (!hasRoot) throw new CliInputError(`${command} requires --root or --url`);
    if (flags["token-file"] || flags["ca-file"] || flags.mode) {
      throw new CliInputError("remote options require --url");
    }
    return;
  }
  validateRemoteEndpoint(flags);
}

function validateRemoteEndpoint(flags) {
  if (!flags["token-file"]) throw new CliInputError("remote commands require --token-file");
  const endpoint = parseEndpoint(flags.url);
  validateEndpointShape(endpoint);
  validateEndpointProtocol(endpoint, flags);
}

function parseEndpoint(url) {
  try {
    return new URL(url);
  } catch {
    throw new CliInputError("--url must be a valid HTTP(S) origin");
  }
}

function validateEndpointShape(endpoint) {
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new CliInputError("--url must not contain credentials, a path, query, or fragment");
  }
}

function validateEndpointProtocol(endpoint, flags) {
  if (endpoint.protocol === "http:") {
    const literalLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
    if (flags.mode !== "local" || !literalLoopback) {
      throw new CliInputError("HTTP requires --mode local and a literal loopback URL");
    }
    return;
  }
  if (endpoint.protocol !== "https:") throw new CliInputError("--url must use HTTPS");
  if (flags.mode) throw new CliInputError("--mode is only valid for HTTP local mode");
}

function validateRequiredFlags(command, flags) {
  if (command === "send" || command === "post") required(flags, "sid");
  if (command === "pending") required(flags, "sid");
  if (["claim", "touch", "ack", "release"].includes(command)) required(flags, "sid");
  if (command === "ack") required(flags, "outcome");
}

function required(flags, key) {
  if (!flags[key]) throw new CliInputError(`--${key} is required`);
}

const helpText = `Relay\n\nCommands: setup register enroll join resume renew leave send post claim touch ack release get list pending stats audit snapshot purge migrate serve delivery-status delivery-reconcile\n\nLocal routes use --root PATH. Bare serve (npm start) initializes/reuses the private .local/ host profile on 0.0.0.0:4200; its HTTP listener allows loopback and Tailscale IPv4 peers only and requires a viewer token. Existing generated loopback profiles are upgraded without rotating credentials. Local startup also attempts a Wayland clipboard copy using optional wl-copy; --no-copy-token or --json skips copying. Custom serve profiles require both --root PATH and --config FILE and never touch the clipboard. Remote CLI routes use --url HTTPS_ORIGIN --token-file FILE, with optional --ca-file FILE. HTTP CLI clients require --mode local and a literal loopback URL. Use delivery-status --root PATH --config FILE for read-only redacted diagnostics. Reconciliation requires --confirm and --reason-code operator-confirmed while the broker is stopped. Migration requires an unused backup path; rollback to v2 requires --config FILE with delivery disabled. Use --json for exact JSON output.\n`;

export async function readEnvelope(stream = process.stdin) {
  const source = await readStdinSource(stream);
  const value = parseStrictJson(source);
  validateEnvelope(value);
  return value;
}

async function readStdinSource(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_537) throw new CliInputError("stdin envelope exceeds 65,536 bytes plus framing");
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new CliInputError("stdin is not valid UTF-8");
  }
}

function validateEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliInputError("stdin must contain one envelope object");
  }
  if (containsNul(value)) throw new CliInputError("stdin envelope values must not contain NUL");
  const keys = Object.keys(value);
  if (keys.length !== 1 || !["msg", "work"].includes(keys[0])) {
    throw new CliInputError("envelope must contain exactly one msg or work key");
  }
  if (keys[0] === "msg" && (typeof value.msg !== "string" || value.msg.length === 0)) {
    throw new CliInputError("msg must be a nonempty string");
  }
}

function containsNul(value) {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key.includes("\0") || containsNul(item));
  }
  return false;
}

export function parseStrictJson(source) {
  try {
    return parseStrictJsonText(source, { maxBytes: 65_537, maxDepth: 128 });
  } catch {
    throw new CliInputError(
      "stdin must contain one strict JSON value without duplicate object keys",
    );
  }
}

export async function main(argv = process.argv.slice(2), io = process) {
  loadDotEnv();
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return reportError(error, argv.includes("--json"), io);
  }
  if (parsed.help) {
    io.stdout.write(helpText);
    return 0;
  }
  const { command, flags } = parsed;
  let envelope;
  try {
    envelope = await readCommandEnvelope(command, flags, io);
  } catch (error) {
    return reportError(error, Boolean(flags.json), io);
  }
  return runCommand(parsed, envelope, io);
}

async function readCommandEnvelope(command, flags, io) {
  if (command !== "send" && command !== "post") return undefined;
  const envelope = await readEnvelope(io.stdin);
  if (command === "post" && envelope.msg && (flags.need?.length || flags.series !== undefined)) {
    throw new CliInputError("--need and --series require a {work: ...} envelope");
  }
  return envelope;
}

async function runCommand(parsed, envelope, io) {
  const { command, positional, flags } = parsed;
  const session = { handle: undefined };
  try {
    const api = await import("./index.mjs");
    const local = await runLocalCommand(api, command, flags, positional, parsed, io, session);
    if (local !== null) return local.code;
    session.handle = await openHandle(api, flags, parsed);
    const method = methodArgs(command, positional, flags, envelope);
    const result = await session.handle[command](...method);
    return output(result, flags.json, command, io);
  } catch (error) {
    return reportError(error, Boolean(flags.json), io);
  } finally {
    await closeHandle(session.handle, io);
  }
}

async function runLocalCommand(api, command, flags, positional, parsed, io, session) {
  if (command === "setup") {
    const result = api.setup({
      root: flags.root,
      ...(flags.device ? { device: flags.device } : {}),
      ...(flags.role ? { role: flags.role } : {}),
    });
    return { code: output(result, flags.json, command, io) };
  }
  if (command === "enroll") return { code: await enrollCommand(api, flags, io) };
  if (command === "serve") return { code: await serveCommand(api, flags, parsed, io) };
  if (command === "migrate") return { code: await migrateCommand(flags, io) };
  if (command === "delivery-reconcile")
    return { code: await reconcileCommand(flags, positional, io) };
  if (command === "delivery-status") return deliveryStatusCommand(api, flags, io, session);
  if (command === "purge") return purgeCommand(api, flags, io, session);
  return null;
}

async function enrollCommand(api, flags, io) {
  const { readConfig } = await import("./config.mjs");
  const config = await readConfig(flags.config);
  if (!config.hub) throw new CliInputError("config has no fixed hub binding");
  const local = api.open({ root: flags.root, readOnly: true });
  try {
    const client = await api.connect({
      url: config.hub.url,
      tokenFile: config.hub.tokenFile,
      ...(config.hub.caFile ? { caFile: config.hub.caFile } : {}),
    });
    try {
      return output(await client.enroll(local.device), flags.json, "enroll", io);
    } finally {
      await client.close();
    }
  } finally {
    local.close();
  }
}

async function serveCommand(api, flags, parsed, io) {
  let profile;
  if (parsed.defaultLocal) {
    const { prepareLocalProfile } = await import("./config.mjs");
    profile = await prepareLocalProfile(flags.root, flags.config);
  }
  return serve(api, flags, io, profile);
}

async function migrateCommand(flags, io) {
  const { migrateLocalStore } = await import("./broker.mjs");
  const result = await migrateLocalStore({
    root: flags.root,
    to: Number(flags.to),
    backup: flags.backup,
    ...(flags.config ? { configFile: flags.config } : {}),
  });
  return output(result, flags.json, "migrate", io);
}

async function reconcileCommand(flags, positional, io) {
  const { reconcileLocalDelivery } = await import("./broker.mjs");
  const result = await reconcileLocalDelivery({
    root: flags.root,
    id: positional[0],
    outcome: flags.outcome,
    confirm: flags.confirm,
    reasonCode: flags["reason-code"],
  });
  return output(result, flags.json, "delivery-reconcile", io);
}

async function deliveryStatusCommand(api, flags, io, session) {
  const [{ readConfig }, { deliveryStatus }, { inspectDeliveryAdapters }] = await Promise.all([
    import("./config.mjs"),
    import("./relay.mjs"),
    import("./delivery.mjs"),
  ]);
  const config = await readConfig(flags.config);
  session.handle = api.open({ root: flags.root, readOnly: true });
  const core = deliveryStatus(session.handle);
  const clients = await inspectDeliveryAdapters(config.delivery.clients);
  const result = Object.freeze({
    configuredEnabled: config.delivery.enabled,
    pollMs: config.delivery.pollMs,
    clients,
    ...core,
  });
  return { code: output(result, flags.json, "delivery-status", io) };
}

function purgeCommand(api, flags, io, session) {
  session.handle = api.open({ root: flags.root });
  const result = session.handle.purge({
    before: Number(flags.before),
    ...(flags.dry ? { dry: true } : {}),
  });
  return { code: output(result, flags.json, "purge", io) };
}

async function openHandle(api, flags, parsed) {
  if (flags.url !== undefined) {
    return await api.connect({
      url: flags.url,
      tokenFile: flags["token-file"],
      ...(flags["ca-file"] ? { caFile: flags["ca-file"] } : {}),
      ...(flags.mode ? { mode: flags.mode } : {}),
    });
  }
  return api.open({ root: flags.root, ...(parsed.readOnly ? { readOnly: true } : {}) });
}

async function closeHandle(handle, io) {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    io.stderr.write(`cleanup: resource close failed (${safeText(error?.code ?? "runtime")})\n`);
    io.exitCode = Math.max(io.exitCode ?? 0, 1);
  }
}

const methodArgBuilders = {
  register: ({ one, flags }) => [
    one,
    { ...(flags.slot ? { slot: flags.slot } : {}), ...(flags.cap ? { caps: flags.cap } : {}) },
  ],
  join: ({ one, flags }) => [one, flags.replace ? { replace: true } : {}],
  resume: ({ one }) => [one],
  renew: ({ one }) => [one],
  leave: ({ one }) => [one],
  send: ({ one, flags, envelope }) => [flags.sid, one, envelope, keyOptions(flags)],
  post: ({ one, flags, envelope }) => [
    flags.sid,
    one,
    envelope,
    {
      ...keyOptions(flags),
      ...(flags.need ? { needs: flags.need } : {}),
      ...(flags.series ? { series: flags.series } : {}),
    },
  ],
  claim: ({ flags }) => [
    flags.sid,
    { ...(flags.board ? { board: flags.board } : {}), ...(flags.kind ? { kind: flags.kind } : {}) },
  ],
  touch: ({ one, flags }) => [flags.sid, one],
  release: ({ one, flags }) => [flags.sid, one],
  ack: ({ one, flags }) => [flags.sid, one, flags.outcome],
  get: ({ one, flags }) => [one, flags.data ? { data: true } : {}],
  list: ({ flags }) => [
    { ...pick(flags, ["to", "board", "kind", "state"]), ...(flags.data ? { data: true } : {}) },
  ],
  stats: () => [],
  pending: ({ flags }) => [flags.sid],
  audit: ({ flags }) => [pick(flags, ["after"])],
  snapshot: ({ flags }) => [
    { ...pick(flags, ["device", "after"]), ...(flags.limit ? { limit: Number(flags.limit) } : {}) },
  ],
};

function methodArgs(command, positional, flags, envelope) {
  const build = methodArgBuilders[command];
  if (!build) throw new CliInputError(`command is not implemented: ${command}`);
  return build({ one: positional[0], flags, envelope });
}

function keyOptions(flags) {
  return flags.key ? { key: flags.key } : {};
}

function pick(source, keys) {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

export async function copyViewerToken(tokenFile, { env = process.env, signal } = {}) {
  if (!env.WAYLAND_DISPLAY || !env.XDG_RUNTIME_DIR || signal?.aborted) return false;
  const { readToken } = await import("./client.mjs");
  let token;
  try {
    token = await readToken(tokenFile);
  } catch {
    return false;
  }
  if (signal?.aborted) return false;
  return new Promise((resolveCopy) => {
    const child = spawn("wl-copy", ["--type", "text/plain", "--sensitive"], {
      env,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
    let failed = false;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 2_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", () => {
      failed = true;
    });
    child.stdin?.on("error", () => {
      failed = true;
    });
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
  const stopped = new Promise((resolveStop) => {
    requestStop = () => {
      clipboardController.abort();
      resolveStop();
    };
  });
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    const described = describeServe(broker.address, profile);
    writeServeInfo(described, profile, flags, io);
    await copyServeToken(profile, flags, io, clipboardController.signal);
    await stopped;
    return 0;
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await broker.close();
  }
}

function describeServe(address, profile) {
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  if (!profile) return { host, info: { address } };
  const localUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;
  const tailscaleIp = networkInterfaces().tailscale0?.find(
    (entry) => entry.family === "IPv4" && !entry.internal,
  )?.address;
  const tailnetUrl =
    host === "0.0.0.0" && tailscaleIp ? `http://${tailscaleIp}:${address.port}` : null;
  return {
    host,
    info: {
      address,
      url: localUrl,
      tokenFile: profile.tokenFile,
      ...(tailnetUrl ? { tailnetUrl } : {}),
    },
  };
}

function writeServeInfo(described, profile, flags, io) {
  if (flags.json) {
    io.stdout.write(`${JSON.stringify(described.info)}\n`);
    return;
  }
  if (!profile) {
    io.stdout.write(`Listening: ${described.host}:${described.info.address.port}\n`);
    return;
  }
  const tailnetUrl = described.info.tailnetUrl;
  io.stdout.write(
    `Relay: ${described.info.url}${tailnetUrl ? `\nTailscale: ${tailnetUrl}` : ""}\nViewer token file: ${safeText(described.info.tokenFile)}\n`,
  );
}

async function copyServeToken(profile, flags, io, signal) {
  if (!profile || flags.json || flags["no-copy-token"]) return;
  const copied = await copyViewerToken(profile.tokenFile, { signal });
  if (signal.aborted) return;
  io.stdout.write(
    copied
      ? "Viewer token copied to clipboard. Paste it into Bearer token, then Connect.\n"
      : "Clipboard unavailable. Copy the viewer token from the file above.\n",
  );
}

function output(value, json, command, io) {
  if (json) io.stdout.write(`${JSON.stringify(value)}\n`);
  else if (command === "register") io.stdout.write(`${safeText(value.id)}\n`);
  else io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function safeText(value) {
  return String(value).replace(/[\p{Cc}]/gu, "?");
}

const faultCodes = new Set([
  "input",
  "data",
  "missing",
  "schema",
  "active",
  "session",
  "expired",
  "target",
  "device_conflict",
  "board",
  "key_conflict",
  "ack_conflict",
  "owner",
  "lease",
  "full",
  "busy",
  "clock",
  "storage",
  "auth",
  "denied",
  "protocol",
  "tls",
  "rpc_conflict",
  "uncertain",
  "cursor",
  "reset",
  "rate",
  "timeout",
  "unavailable",
]);

function reportError(error, json, io) {
  const knownFault = faultCodes.has(error?.code);
  const code =
    error instanceof CliInputError || ["input", "data", "protocol"].includes(error?.code)
      ? 2
      : knownFault && error.code !== "storage"
        ? 3
        : 1;
  const label = knownFault ? String(error.code) : code === 2 ? "input" : "runtime";
  const message =
    error instanceof CliInputError || knownFault
      ? safeText(error?.message ?? error)
      : "storage/runtime failure";
  const record = { error: { code: label, message } };
  io.stderr.write(
    json ? `${JSON.stringify(record)}\n` : `${record.error.code}: ${record.error.message}\n`,
  );
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = Math.max(await main(), process.exitCode ?? 0);
}
