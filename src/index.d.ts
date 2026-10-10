export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Kind = "msg" | "work";
export type StoreRole = "host" | "hub";
export type WorkerAddress = string;
export type BoardId = "bounty" | `host:${string}`;
export type MessageState = "pending" | "claimed" | "posted" | "done" | "failed" | "rejected";
export type AckOutcome = "done" | "failed" | "rejected";
export type AgentState = "registered" | "starting" | "ready" | "busy" | "unknown" | "stale";

export type Envelope =
  | { msg: string; work?: never }
  | { work: JsonValue; msg?: never };

export interface Device {
  id: string;
  name: string;
  init: number;
}

export interface EnrollmentReceipt extends Device {
  repeat: boolean;
}

export interface Agent {
  id: WorkerAddress;
  device: string;
  runtime: string;
  slot: string;
  caps: string[];
  epoch: number;
  init: number;
}

export interface Board {
  id: BoardId;
  kind: "bounty" | "host";
  device: string | null;
  authority: string;
}

export interface Session {
  id: string;
  worker: WorkerAddress;
  epoch: number;
  until: number;
  ended: number | null;
}

export interface Message {
  id: string;
  seq: number;
  from: WorkerAddress | null;
  to: WorkerAddress | null;
  board: BoardId | null;
  kind: Kind;
  needs: string[];
  series: string | null;
  data?: Envelope;
  state: MessageState;
  init: number;
  acked: number | null;
}

export interface Lease {
  id: string;
  mid: string;
  sid: string;
  epoch: number;
  until: number;
  attempt: number;
  kind: Kind;
  msg?: string;
  work?: JsonValue;
}

export interface Receipt {
  mid: string;
  lease: string;
  sid: string;
  epoch: number;
  outcome: AckOutcome;
  time: number;
}

export interface AdmissionReceipt {
  id: string;
  repeat: boolean;
  init: number;
}

export interface EndReceipt {
  sid: string;
  epoch: number;
  ended: number;
}

export interface ReleaseReceipt {
  mid: string;
  lease: string;
  sid: string;
  epoch: number;
  outcome: "released";
  time: number;
}

export type FaultCode =
  | "input" | "data" | "missing" | "schema" | "active" | "session" | "expired"
  | "target" | "device_conflict" | "board" | "key_conflict" | "ack_conflict"
  | "owner" | "lease" | "full" | "busy" | "clock" | "storage" | "auth"
  | "denied" | "protocol" | "tls" | "rpc_conflict" | "uncertain" | "cursor"
  | "reset" | "rate" | "timeout" | "unavailable";

export interface FaultContext {
  id?: string;
  mid?: string;
  sid?: string;
  lease?: string;
  retryAfterMs?: number;
}

export class Fault extends Error {
  readonly code: FaultCode;
  readonly context?: FaultContext;
  constructor(code: FaultCode, message: string, context?: FaultContext);
}

export interface Principal {
  id: string;
  grant: Grant;
  scopeKey: string;
}

export interface Grant {
  enroll: Array<{ deviceId: string; deviceName: string }>;
  register: Array<{
    deviceId: string;
    deviceName: string;
    runtimes: string[];
    allocate: boolean;
  }>;
  workers: WorkerAddress[];
  recipients: WorkerAddress[];
  boardPost: BoardId[];
  boardClaim: BoardId[];
  inboxRead: BoardId[];
  workRead: BoardId[];
  inspect: {
    messages: boolean;
    receipts: boolean;
    audit: boolean;
    topology: boolean;
  };
  reportDevice: string | null;
}

export interface Stats {
  authority: string;
  time: number;
  messages: {
    pending: number;
    claimed: number;
    posted: number;
    done: number;
    failed: number;
    rejected: number;
    rows: number;
    bytes: number;
  };
  sessions: { live: number; ended: number };
  leases: { live: number; total: number };
  receipts: number;
  devices: number;
  agents: number;
  boards: number;
  audit: { rows: number; pruned: number };
}

export interface AuditEvent {
  seq: number;
  time: number;
  type: string;
  worker: WorkerAddress | null;
  sid: string | null;
  mid: string | null;
  lease: string | null;
  code: FaultCode | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  visible: number;
  complete: boolean;
  cursor: string;
  next: string | null;
  firstSeq: number | null;
  pruned: number;
}

export interface ListOptions {
  to?: WorkerAddress;
  board?: BoardId;
  kind?: Kind;
  state?: MessageState;
  after?: string;
  limit?: number;
  data?: boolean;
}

export interface AuditOptions {
  after?: string;
  limit?: number;
}

export interface ReportAgent {
  worker: WorkerAddress;
  state: "starting" | "ready" | "busy" | "unknown";
  free: 0 | 1 | null;
  assignmentCount: 0 | 1;
}

export interface ReportBoard {
  id: BoardId;
  inbox: number;
  pending: number;
  claimed: number;
  terminal: number;
}

export interface ReportEvent {
  seq: number;
  type: "post" | "claim" | "release" | "ack" | "refusal";
  from: string;
  to: string;
  mid: string | null;
  state: MessageState | null;
  code: FaultCode | null;
}

export interface ReportInput {
  seq: number;
  agents: ReportAgent[];
  board: ReportBoard;
  events?: ReportEvent[];
}

export interface ReportReceipt {
  accepted: true;
  receivedAt: number;
  staleAfter: number;
  seq: number;
}

export interface SnapshotDevice extends Device {
  authority: string;
  receivedAt: number | null;
  stale: boolean;
  free: number | null;
}

export interface SnapshotAgent extends Agent {
  state: AgentState;
  assignmentCount: number;
  receivedAt: number | null;
}

export interface SnapshotBoard extends Board {
  inbox: number;
  pending: number;
  claimed: number;
  terminal: number;
  reported: boolean;
  receivedAt: number | null;
}

export interface SnapshotLink {
  id: string;
  from: string;
  to: string;
  kind: "addressed" | "board" | "report";
  state: "active" | "stale" | "unknown";
  mid: string | null;
  time: number | null;
}

export interface Snapshot {
  v: 1;
  authority: string;
  time: number;
  cursor: string;
  devices: SnapshotDevice[];
  agents: SnapshotAgent[];
  boards: SnapshotBoard[];
  links: SnapshotLink[];
  totals: { devices: number; agents: number; boards: number; links: number };
  visible: { devices: number; agents: number; boards: number; links: number };
  complete: boolean;
  next: string | null;
}

export interface SetupOptions {
  root: string;
  device?: string;
  role?: StoreRole;
}

export interface OpenOptions extends SetupOptions {
  sessionMs?: number;
  claimMs?: number;
  keyMs?: number;
  readOnly?: boolean;
}

export interface RegisterOptions {
  slot?: string;
  caps?: readonly string[];
}

export interface JoinOptions {
  replace?: boolean;
}

export interface KeyOptions {
  key?: string;
}

export interface PostOptions extends KeyOptions {
  needs?: readonly string[];
  series?: string;
}

export interface ClaimOptions {
  board?: BoardId;
  kind?: Kind;
}

export interface GetOptions {
  data?: boolean;
}

export interface SnapshotOptions {
  device?: string;
  limit?: number;
  after?: string;
}

export interface PurgeOptions {
  before: number;
  dry?: boolean;
}

export interface PurgeResult {
  dry: boolean;
  eligible: number;
  removed: number;
  before: number;
}

export declare class Relay {
  private constructor();
  readonly device: Device;
  readonly authority: string;
  register(runtime: string, options?: RegisterOptions): Agent;
  enroll(device: Device): EnrollmentReceipt;
  join(worker: WorkerAddress, options?: JoinOptions): Session;
  resume(sid: string): Session;
  renew(sid: string): Session;
  leave(sid: string): EndReceipt;
  send(sid: string, to: WorkerAddress, envelope: Envelope, options?: KeyOptions): AdmissionReceipt;
  post(sid: string, board: BoardId, envelope: Envelope, options?: PostOptions): AdmissionReceipt;
  claim(sid: string, options?: ClaimOptions): Lease | null;
  touch(sid: string, lease: string): Lease;
  ack(sid: string, lease: string, outcome: AckOutcome): Receipt;
  release(sid: string, lease: string): ReleaseReceipt;
  get(id: string, options?: GetOptions): Message | null;
  list(options?: ListOptions): Page<Message>;
  stats(): Stats;
  audit(options?: AuditOptions): Page<AuditEvent>;
  report(sid: string, report: ReportInput): ReportReceipt;
  snapshot(options?: SnapshotOptions): Snapshot;
  purge(options: PurgeOptions): PurgeResult;
  close(): void;
}

export interface ClientOptions {
  url: string;
  tokenFile: string;
  caFile?: string;
  mode?: "local" | "lan" | "tailscale";
}

export interface BrokerOptions {
  root: string;
  configFile: string;
}

export interface BrokerAddress {
  address: string;
  family: "IPv4" | "IPv6";
  port: number;
}

export declare class Client {
  private constructor();
  readonly authority: string;
  register(runtime: string, options?: RegisterOptions): Promise<Agent>;
  enroll(device: Device): Promise<EnrollmentReceipt>;
  join(worker: WorkerAddress, options?: JoinOptions): Promise<Session>;
  resume(sid: string): Promise<Session>;
  renew(sid: string): Promise<Session>;
  leave(sid: string): Promise<EndReceipt>;
  send(sid: string, to: WorkerAddress, envelope: Envelope, options?: KeyOptions): Promise<AdmissionReceipt>;
  post(sid: string, board: BoardId, envelope: Envelope, options?: PostOptions): Promise<AdmissionReceipt>;
  claim(sid: string, options?: ClaimOptions): Promise<Lease | null>;
  touch(sid: string, lease: string): Promise<Lease>;
  ack(sid: string, lease: string, outcome: AckOutcome): Promise<Receipt>;
  release(sid: string, lease: string): Promise<ReleaseReceipt>;
  get(id: string, options?: GetOptions): Promise<Message | null>;
  list(options?: ListOptions): Promise<Page<Message>>;
  stats(): Promise<Stats>;
  audit(options?: AuditOptions): Promise<Page<AuditEvent>>;
  report(sid: string, report: ReportInput): Promise<ReportReceipt>;
  snapshot(options?: SnapshotOptions): Promise<Snapshot>;
  close(): Promise<void>;
}

export declare class Broker {
  private constructor();
  readonly address: BrokerAddress | null;
  close(): Promise<void>;
}

export interface Limits {
  sessionMs: number;
  claimMs: number;
  resumeMs: number;
  keyMs: number;
  payloadBytes: number;
  deviceNameChars: number;
  runtimeNameChars: number;
  slotDigitsMin: number;
  slotDigitsMax: number;
  pageDefault: number;
  pageMax: number;
  workerAddressBytes: number;
  needsMax: number;
  tagCharsMax: number;
  seriesCharsMax: number;
  keyBytesMax: number;
  pendingMessages: number;
  pendingBytes: number;
  retainedMessages: number;
  retainedBytes: number;
  terminalRetentionMs: number;
  auditRetentionMs: number;
  auditRows: number;
  auditBytes: number;
  rpcRetentionMs: number;
  rpcRows: number;
  rpcBytes: number;
  headerBytes: number;
  requestBytes: number;
  responseBytes: number;
  requestDeadlineMs: number;
  clientDeadlineMs: number;
  connectionDeadlineMs: number;
  busyTimeoutMs: number;
  brokerBusyTimeoutMs: number;
  concurrentRequests: number;
  concurrentPerPrincipal: number;
  ratePerMinute: number;
  rateBurst: number;
  snapshotDevices: number;
  snapshotAgents: number;
  reportBytes: number;
  eventBytes: number;
  feedEvents: number;
  feedStreams: number;
  streamQueuedBytes: number;
  keepaliveMs: number;
  reportIntervalMs: number;
  reportStaleMs: number;
  maxCredentials: number;
  rateIdleMs: number;
  poolMaxAgents: number;
  poolMaxJobs: number;
  poolPollMs: number;
  poolMinBackoffMs: number;
  poolMaxBackoffMs: number;
  launchMaxChildren: number;
  launchReadyTimeoutMs: number;
}

export const LIMITS: Readonly<Limits>;
export function open(options: OpenOptions): Relay;
export function setup(options: SetupOptions): Device;
export function connect(options: ClientOptions): Promise<Client>;
export function serve(options: BrokerOptions): Promise<Broker>;
