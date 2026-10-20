import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";

const packageRoot = process.argv[3];
if (packageRoot !== undefined && !isAbsolute(packageRoot))
  throw new Error("An absolute installed package root is required");
const source = (name) =>
  packageRoot
    ? pathToFileURL(join(packageRoot, "src", name)).href
    : new URL(`../../../src/${name}`, import.meta.url).href;
const { setup } = await import(source("index.mjs"));
const { openForBroker, claimDeliveryOwner, listDeliveryAttempts, listDeliveryBindings } =
  await import(source("relay.mjs"));
const { createDeliverySupervisor } = await import(source("delivery.mjs"));

const root = process.argv[2];
if (!root) throw new Error("An owned temporary Relay root is required");
setup({ root, device: "spike", role: "host" });
const local = openForBroker({ root, role: "host", ownerToken: randomBytes(16).toString("hex") });
let supervisor;
let closing;
const close = () =>
  (closing ??= (async () => {
    try {
      await supervisor?.close();
    } finally {
      local.close();
    }
  })());
try {
  const worker = local.register("opencode");
  const session = local.join(worker.id);
  const owner = claimDeliveryOwner(local);
  supervisor = createDeliverySupervisor({
    local,
    hub: null,
    pool: null,
    launchConfigured: false,
    ownerGeneration: owner.generation,
    clients: ["opencode"],
    pollMs: 250,
  });
  await supervisor.start();
  process.stdout.write(
    `${JSON.stringify({ authority: local.authority, worker: worker.id, sid: session.id, epoch: session.epoch })}\n`,
  );
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line === "status" || line === "refresh") {
      if (line === "refresh") await supervisor.refresh();
      process.stdout.write(
        `${JSON.stringify({
          status: supervisor.status(),
          pending: local.pending(session.id).pending,
          attemptStates: listDeliveryAttempts(local, owner.generation).map(
            (attempt) => attempt.state,
          ),
          attemptPhases: listDeliveryAttempts(local, owner.generation).map(
            ({ state, nativeRequestId, admittedAt, contextAt, turnAt, safeIdleAt }) => ({
              state,
              nativeRequestId,
              admittedAt,
              contextAt,
              turnAt,
              safeIdleAt,
            }),
          ),
        })}\n`,
      );
    } else if (line.startsWith("binding ")) {
      const nativeSession = line.slice("binding ".length);
      if (!/^ses_[A-Za-z0-9_-]{1,120}$/.test(nativeSession))
        throw new Error("Invalid disposable native session identity");
      const bindings = listDeliveryBindings(local, owner.generation).filter(
        (binding) => binding.state === "active",
      );
      const exactMapping =
        bindings.length === 1 &&
        bindings.every(
          (binding) =>
            binding.authority === local.authority &&
            binding.worker === worker.id &&
            binding.sid === session.id &&
            binding.epoch === session.epoch &&
            binding.ownerGeneration === owner.generation &&
            binding.target.nativeSession === nativeSession &&
            binding.target.profile === "isolated-version-spike",
        );
      process.stdout.write(
        `${JSON.stringify({ activeBindings: bindings.length, exactMapping })}\n`,
      );
    } else if (line === "deliver" || line === "deliver-busy") {
      if (
        listDeliveryBindings(local, owner.generation).filter(
          (binding) => binding.state === "active",
        ).length !== 1
      )
        throw new Error("Native delivery requires one exact active binding");
      const pending = local.pending(session.id).pending;
      if (pending.msg !== 0 || pending.work !== 0)
        throw new Error("Native delivery probe queue is not empty");
      local.send(session.id, worker.id, {
        msg: "Isolated native-delivery probe payload; do not expose it in the notice",
      });
      if (line === "deliver-busy")
        local.send(session.id, worker.id, {
          work: "Isolated native-delivery probe payload; bounded work verification only",
        });
      await supervisor.refresh();
      process.stdout.write(`${JSON.stringify({ queued: true })}\n`);
    } else if (line === "enqueue") {
      if (Object.keys(supervisor.status().core.bindings).length)
        throw new Error("This rejection probe cannot enqueue for a native binding");
      local.send(session.id, worker.id, { msg: "disposable spike body: never a native notice" });
      process.stdout.write(`${JSON.stringify({ queued: true })}\n`);
    } else if (line === "stop") {
      await close();
      process.stdout.write(`${JSON.stringify({ closed: true })}\n`);
      input.close();
      break;
    } else throw new Error("Unknown spike command");
  }
} finally {
  await close();
}
