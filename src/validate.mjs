import { createHash } from "node:crypto";
import { Fault } from "./fault.mjs";

export const DELIVERY_CLIENTS = Object.freeze([
  "codex",
  "cursor",
  "omp",
  "antigravity",
  "hermes",
  "zed",
  "zcode",
  "opencode",
  "kilo",
  "cline",
]);

export const LIMITS = Object.freeze({
  sessionMs: 120000,
  claimMs: 30000,
  resumeMs: 300000,
  keyMs: 86400000,
  payloadBytes: 65536,
  deviceNameChars: 63,
  runtimeNameChars: 32,
  slotDigitsMin: 3,
  slotDigitsMax: 32,
  pageDefault: 50,
  pageMax: 200,
  workerAddressBytes: 160,
  needsMax: 16,
  tagCharsMax: 32,
  seriesCharsMax: 64,
  keyBytesMax: 128,
  pendingMessages: 10000,
  pendingBytes: 134217728,
  retainedMessages: 50000,
  retainedBytes: 268435456,
  terminalRetentionMs: 604800000,
  auditRetentionMs: 2592000000,
  auditRows: 100000,
  auditBytes: 33554432,
  rpcRetentionMs: 86400000,
  rpcRows: 100000,
  rpcBytes: 33554432,
  headerBytes: 8192,
  requestBytes: 131072,
  responseBytes: 1048576,
  requestDeadlineMs: 10000,
  clientDeadlineMs: 10000,
  connectionDeadlineMs: 3000,
  busyTimeoutMs: 5000,
  brokerBusyTimeoutMs: 100,
  concurrentRequests: 32,
  concurrentPerPrincipal: 8,
  ratePerMinute: 60,
  rateBurst: 10,
  snapshotDevices: 64,
  snapshotAgents: 512,
  reportBytes: 32768,
  eventBytes: 16384,
  feedEvents: 2048,
  feedStreams: 8,
  streamQueuedBytes: 65536,
  keepaliveMs: 15000,
  reportIntervalMs: 10000,
  reportStaleMs: 30000,
  maxCredentials: 256,
  rateIdleMs: 120000,
  poolMaxAgents: 8,
  poolMaxJobs: 1,
  poolPollMs: 1000,
  poolMinBackoffMs: 250,
  poolMaxBackoffMs: 10000,
  launchMaxChildren: 16,
  launchReadyTimeoutMs: 10000,
  deliveryBindings: 64,
  deliveryBindingsMax: 512,
  deliveryRows: 10000,
  deliveryPollMs: 1000,
  deliveryPollMinMs: 250,
  deliveryPollMaxMs: 30000,
  deliveryNativeCalls: 4,
  deliveryDeadlineMs: 10000,
  deliveryRetryMinMs: 250,
  deliveryRetryMaxMs: 10000,
  deliveryRetries: 3,
  deliveryNoticeBytes: 2048,
});

const invalid = (message) => {
  throw new Fault("input", message);
};
const namePattern = /^[A-Za-z0-9._-]+$/;

export function validateDeviceName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > LIMITS.deviceNameChars ||
    !namePattern.test(value)
  )
    invalid("Invalid device name");
  return value;
}
export function validateRuntime(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > LIMITS.runtimeNameChars ||
    !namePattern.test(value)
  )
    invalid("Invalid runtime name");
  return value;
}
export function validateSlot(value, { prime = false } = {}) {
  if (prime && value === "prime") return value;
  if (typeof value !== "string" || !/^[0-9]{3,32}$/.test(value) || !/[1-9]/.test(value))
    invalid("Invalid worker slot");
  return value;
}
export function validateAddress(address) {
  if (
    typeof address !== "string" ||
    Buffer.byteLength(address, "ascii") !== address.length ||
    address.length > LIMITS.workerAddressBytes
  )
    invalid("Invalid worker address");
  const parts = address.split(":");
  if (parts.length !== 3) invalid("Invalid worker address");
  const [device, runtime, slot] = parts;
  validateDeviceName(device);
  validateRuntime(runtime);
  validateSlot(slot, { prime: true });
  return { device, runtime, slot };
}
export function validateTags(value, label = "capabilities") {
  if (
    !Array.isArray(value) ||
    value.length > LIMITS.needsMax ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid(`Invalid ${label}`);
  const tags = Array.from({ length: value.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      invalid(`Invalid ${label}`);
    const item = descriptor.value;
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > LIMITS.tagCharsMax ||
      !namePattern.test(item)
    )
      invalid(`Invalid ${label}`);
    return item;
  });
  if (new Set(tags).size !== tags.length) invalid(`Duplicate ${label}`);
  return tags.sort();
}
export function validateKey(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > LIMITS.keyBytesMax ||
    /\p{Cc}/u.test(value)
  )
    invalid("Invalid key");
  return value;
}

function encodeNumber(value) {
  if (!Number.isFinite(value)) throw new Fault("data", "Payload contains a non-finite number");
  if (Object.is(value, -0)) return "-0";
  return JSON.stringify(value);
}

function encodeArray(value, active) {
  if (Object.getPrototypeOf(value) !== Array.prototype)
    throw new Fault("data", "Payload array has an unsupported prototype");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length"))
    throw new Fault("data", "Payload array has extra properties");
  const parts = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Fault("data", "Payload array is sparse or has an accessor");
    parts.push(encode(descriptor.value, active));
  }
  return `[${parts.join(",")}]`;
}

function encodeObject(value, active) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Fault("data", "Payload object has an unsupported prototype");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string"))
    throw new Fault("data", "Payload has symbol keys");
  keys.sort();
  const parts = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new Fault("data", "Payload contains an accessor or hidden property");
    parts.push(`${JSON.stringify(key)}:${encode(descriptor.value, active)}`);
  }
  return `{${parts.join(",")}}`;
}

function encode(value, active) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value !== "object") throw new Fault("data", "Payload is not JSON data");
  if (active.has(value)) throw new Fault("data", "Payload contains a cycle");
  active.add(value);
  try {
    return Array.isArray(value) ? encodeArray(value, active) : encodeObject(value, active);
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value, maxBytes = LIMITS.payloadBytes) {
  let json;
  try {
    json = encode(value, new Set());
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("data", "Payload is not representable JSON", { cause: error });
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) throw new Fault("data", "Payload exceeds the encoded size limit");
  return { json, bytes };
}
export function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value).json).digest("hex");
}

function envelopeField(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Fault("data", "Invalid envelope");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || typeof keys[0] !== "string")
    throw new Fault("data", "Envelope must contain exactly one key");
  const key = keys[0];
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor))
    throw new Fault("data", "Invalid envelope field");
  return { key, body: descriptor.value };
}

function envelopeResult(kind, data) {
  return { kind, data, ...canonicalJson(data) };
}

export function validateEnvelope(value, { board: _board = false } = {}) {
  const field = envelopeField(value);
  if (field.key === "msg") {
    if (typeof field.body !== "string" || field.body.length === 0)
      throw new Fault("data", "Message text must be nonempty");
    return envelopeResult("msg", { msg: field.body });
  }
  if (field.key !== "work") throw new Fault("data", "Envelope must use msg or work");
  return envelopeResult("work", { work: field.body });
}
