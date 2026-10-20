import { createHash } from "node:crypto";
import { open } from "../../src/index.mjs";

let relay;
let session;
let lease = null;
let automatic = false;
let finishing = null;
let stopping = false;

const log = (text) => process.send?.({ type: "log", text });

const status = () =>
  process.send?.({
    type: "state",
    session: session?.id,
    epoch: session?.epoch,
    mid: lease?.mid ?? null,
    automatic,
    pid: process.pid,
  });

function claim() {
  if (lease) throw Error("This worker already holds a claim. Complete it first.");
  lease = relay.claim(session.id, { board: "bounty", kind: "work" });
  log(lease ? `CLAIM committed ${lease.mid}` : "No pending work.");
  status();
}

function complete() {
  if (!lease) throw Error("No active claim.");
  const result = createHash("sha256").update(JSON.stringify(lease.work)).digest("hex");
  const receipt = relay.ack(session.id, lease.id, "done");
  log(`SHA256 ${result}\nACK committed ${receipt.mid} → done`);
  lease = null;
  status();
}

function run() {
  claim();
  if (!lease) return;
  finishing = setTimeout(() => {
    finishing = null;
    try {
      complete();
    } catch (error) {
      log(`ERROR ${error.message}`);
    }
  }, 1800);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  clearInterval(poll);
  clearTimeout(finishing);
  try {
    if (session) relay.leave(session.id);
  } catch (error) {
    log(`Session cleanup: ${error.message}`);
  }
  relay?.close();
  process.exit(0);
}

function attach(message) {
  relay = open({ root: message.root, device: "workspace-fixture" });
  session = relay.join(message.worker);
  log(
    `ATTACHED fixture worker process ${process.pid}\nRelay session epoch ${session.epoch}\nCommands: help, status, claim, complete, run, auto on, auto off, message\nThis is a scoped worker console, NOT an OS shell or AI-agent terminal.`,
  );
  status();
}

function reportStatus() {
  log(`pid=${process.pid} epoch=${session.epoch} claim=${lease?.mid ?? "none"} auto=${automatic}`);
  status();
}

function completeClaim() {
  clearTimeout(finishing);
  finishing = null;
  complete();
}

function setAutomatic(enabled) {
  automatic = enabled;
  log(
    enabled
      ? "Automatic consumption enabled."
      : "Automatic consumption paused; any held work remains owned.",
  );
  status();
}

function postMessage() {
  const posted = relay.post(session.id, "bounty", {
    msg: `Fixture message from worker pid ${process.pid}`,
  });
  log(`MESSAGE committed ${posted.id}`);
  status();
}

const commands = {
  help: () => log("help | status | claim | complete | run | auto on | auto off | message"),
  status: reportStatus,
  claim,
  complete: completeClaim,
  run,
  "auto on": () => setAutomatic(true),
  "auto off": () => setAutomatic(false),
  message: postMessage,
};

function runCommand(command) {
  const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!handler) throw Error("Command not permitted");
  handler();
}

function handleProcessMessage(message) {
  if (message.type === "init") {
    attach(message);
    return;
  }
  if (!session) throw Error("Worker not ready");
  if (message.type === "shutdown") {
    shutdown();
    return;
  }
  if (message.type !== "command") return;
  runCommand(message.command);
}

process.on("message", (message) => {
  try {
    handleProcessMessage(message);
  } catch (error) {
    log(`ERROR ${error.message}`);
    status();
  }
});

const heartbeat = setInterval(() => {
  try {
    if (!session) return;
    relay.renew(session.id);
    if (lease) relay.touch(session.id, lease.id);
  } catch (error) {
    log(`HEARTBEAT ERROR ${error.message}`);
  }
}, 10000);

const poll = setInterval(() => {
  if (!automatic || !session || lease || finishing) return;
  try {
    run();
  } catch (error) {
    log(`ERROR ${error.message}`);
  }
}, 2500);

process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
