import { open } from "../src/relay.mjs";

const relay = open({ root: process.env.RELAY_ROOT });
const started = Date.now();
while (Date.now() - started < 100) {}
const agent = relay.register("allocator");
const lease = relay.claim(process.env.RELAY_SID);
process.send({
  slot: agent.slot,
  lease: lease ? { id: lease.id, until: lease.until, mid: lease.mid } : null,
});
relay.close();
