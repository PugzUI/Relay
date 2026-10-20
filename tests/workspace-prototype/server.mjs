import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PROTOTYPE_PORT ?? 18848);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid PROTOTYPE_PORT");
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
const directory = mkdtempSync(join(tmpdir(), "relay-workspace-"));
mkdirSync(join(directory, "state"));
const root = join(directory, "state");
const relay = open({ root, device: "workspace-fixture", role: "hub" });
const operator = relay.register("worker", { slot: "900" });
const operatorSession = relay.join(operator.id);
const workers = new Map();
const clients = new Set();
const allowed = new Set([
  "help",
  "status",
  "claim",
  "complete",
  "run",
  "auto on",
  "auto off",
  "message",
]);
const types = {
  "/": ["index.html", "text/html"],
  "/app.mjs": ["app.mjs", "text/javascript"],
  "/style.css": ["workspace.css", "text/css"],
  "/relay-style.css": ["../../ui/style.css", "text/css"],
  "/assets/app.js": ["assets/app.js", "text/javascript"],
  "/assets/app.css": ["assets/app.css", "text/css"],
};
const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
let logSeq = 0;
let revision = 0;
let lastHash = "";
let closing = false;

function addLog(worker, text) {
  worker.logs.push({ seq: ++logSeq, text: String(text).slice(0, 4000) });
  if (worker.logs.length > 120) worker.logs.splice(0, worker.logs.length - 120);
}

function spawnWorker(slot, number) {
  const agent = relay.register("worker", { slot: number });
  const worker = {
    id: agent.id,
    slot,
    pid: null,
    session: null,
    epoch: null,
    mid: null,
    automatic: false,
    online: false,
    logs: [],
  };
  const child = fork(join(here, "worker.mjs"), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    cwd: directory,
    env: { ...process.env },
  });
  worker.child = child;
  workers.set(agent.id, worker);
  child.stdout.on("data", (chunk) => addLog(worker, chunk.toString()));
  child.stderr.on("data", (chunk) => addLog(worker, chunk.toString()));
  child.on("message", (message) => {
    if (message.type === "log") addLog(worker, message.text);
    if (message.type === "state") {
      for (const key of ["session", "epoch", "mid", "automatic", "pid"]) worker[key] = message[key];
      worker.online = true;
    }
  });
  child.on("exit", (code, signal) => {
    worker.online = false;
    worker.mid = null;
    addLog(worker, `PROCESS EXIT code=${code} signal=${signal ?? "none"}`);
  });
  child.on("error", (error) => {
    worker.online = false;
    addLog(worker, `PROCESS ERROR ${error.message}`);
  });
  child.send({ type: "init", root, worker: agent.id });
}

function seed(count = 3) {
  const existing = relay.list({ board: "bounty", kind: "work", limit: 100 }).total;
  if (existing + count > 30) throw Error("Fixture work limit is 30");
  for (let i = 0; i < count; i++) {
    relay.post(operatorSession.id, "bounty", {
      work: {
        task: `Package ${existing + i + 1}`,
        input: `fixture-payload-${existing + i + 1}`,
        operation: "sha256",
      },
    });
  }
}

function auditEvents() {
  let page = relay.audit({ limit: 100 });
  const events = [...page.items];
  let pages = 1;
  while (page.next) {
    if (pages++ >= 32) throw Error("Fixture journal capacity reached");
    page = relay.audit({ limit: 100, after: page.next });
    events.push(...page.items);
  }
  return events.slice(-120).map(({ sid, ...event }) => event);
}

function snapshot() {
  return {
    instance: directory.split("/").at(-1),
    revision,
    workers: [...workers.values()].map(({ child, ...worker }) => ({
      ...worker,
      session: worker.session ? { epoch: worker.epoch } : null,
    })),
    work: relay.list({ board: "bounty", kind: "work", data: true, limit: 100 }).items,
    audit: auditEvents(),
  };
}

function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw Error("Request too large");
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected object");
  return value;
}

function openEventStream(req, res) {
  if (clients.size >= 12) return json(res, 429, { error: "Too many streams" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  clients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  req.on("close", () => clients.delete(res));
  return undefined;
}

function serveStatic(res, pathname) {
  const [file, type] = types[pathname];
  const content = readFileSync(join(here, file));
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}

function isScopedCommand(input) {
  if (Object.keys(input).some((key) => !["action", "worker", "command"].includes(key))) {
    return false;
  }
  return allowed.has(input.command);
}

function handleSeed(res, input) {
  if (Object.keys(input).some((key) => key !== "action")) {
    return json(res, 400, { error: "Unexpected fields" });
  }
  seed(3);
  return json(res, 200, { ok: true });
}

async function handleAction(req, res) {
  if (req.headers.origin !== origin || req.headers["x-prototype-token"] !== token) {
    return json(res, 403, { error: "Action denied" });
  }
  if (!String(req.headers["content-type"]).startsWith("application/json")) {
    return json(res, 415, { error: "Expected JSON" });
  }
  const input = await body(req);
  if (input.action === "seed") return handleSeed(res, input);
  const worker = workers.get(input.worker);
  if (!worker?.online || !worker.child.connected) {
    return json(res, 409, { error: "No live fixture session for this node" });
  }
  if (input.action !== "command" || !isScopedCommand(input)) {
    return json(res, 403, {
      error: "Only scoped fixture worker commands are allowed; shell execution is unavailable",
    });
  }
  addLog(worker, `> ${input.command}`);
  worker.child.send({ type: "command", command: input.command });
  return json(res, 202, { accepted: true });
}

async function handleRequest(req, res) {
  try {
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      return json(res, 403, { error: "Origin denied" });
    }
    const url = new URL(req.url, origin);
    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      return json(res, 200, { token, state: snapshot() });
    }
    if (url.pathname === "/api/events" && req.method === "GET") return openEventStream(req, res);
    if (url.pathname === "/api/action" && req.method === "POST")
      return await handleAction(req, res);
    if (req.method === "GET" && types[url.pathname]) return serveStatic(res, url.pathname);
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(`Request handling failed: ${error.message}`);
  });
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;

const refresh = setInterval(() => {
  try {
    const state = snapshot();
    const hash = createHash("sha256")
      .update(JSON.stringify({ ...state, revision: 0 }))
      .digest("hex");
    if (hash === lastHash) return;
    lastHash = hash;
    state.revision = ++revision;
    const payload = `id: ${revision}\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) {
      if (!res.write(payload)) {
        clients.delete(res);
        res.destroy();
      }
    }
  } catch (error) {
    console.error("Snapshot failure", error.message);
  }
}, 200);

const heartbeat = setInterval(() => {
  try {
    relay.renew(operatorSession.id);
  } catch (error) {
    console.error("Operator heartbeat failure", error.message);
  }
  for (const res of clients) res.write(": keepalive\n\n");
}, 10000);

function stopWorker(worker) {
  return new Promise((resolve) => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return resolve();
    const timer = setTimeout(() => worker.child.kill("SIGKILL"), 1500);
    worker.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (worker.child.connected) {
      worker.child.send({ type: "shutdown" }, (error) => {
        if (error) worker.child.kill("SIGTERM");
      });
    } else {
      worker.child.kill("SIGTERM");
    }
  });
}

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(refresh);
  clearInterval(heartbeat);
  for (const res of clients) res.end();
  server.close();
  await Promise.all([...workers.values()].map((worker) => stopWorker(worker)));
  try {
    relay.leave(operatorSession.id);
  } catch (error) {
    console.error(error.message);
  }
  try {
    relay.close();
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(`Fixture cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

for (const [slot, number] of [
  ["alpha", "001"],
  ["beta", "002"],
]) {
  spawnWorker(slot, number);
}
seed();

server.on("error", (error) => {
  console.error(error.message);
  shutdown();
});
server.listen(port, "127.0.0.1", () => {
  writeFileSync(join(directory, "run.json"), JSON.stringify({ origin, root, pid: process.pid }), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ origin, root, pid: process.pid, fixture: true }));
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setTimeout(shutdown, 2 * 60 * 60 * 1000).unref();
