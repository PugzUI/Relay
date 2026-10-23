import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

// A real ACP process, started by the ahpd ACP plugin. It performs no filesystem
// operations and needs no credentials or external model provider.
const sessions = new Map();
const agent = acp.agent({ name: "relay-integration-fixture" });

agent
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: [],
  }))
  .onRequest("session/new", () => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { cancelled: false });
    return { sessionId };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw Error("Unknown fixture session");
    const prompt = (params.prompt || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "AHP accepted the queued prompt. " },
      },
    });

    if (prompt.includes("approval")) {
      const answer = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "fixture-tool-1",
          title: "Fixture permission request",
          kind: "edit",
          status: "pending",
          rawInput: { description: "The fixture never changes files" },
        },
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "approve-once" },
          { kind: "reject_once", name: "Deny this operation", optionId: "deny" },
        ],
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: " Permission " + (answer.outcome?.optionId || answer.outcome?.outcome || "unknown") + ".",
          },
        },
      });
    }

    if (prompt.includes("cancel")) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 8000);
        state.release = () => { clearTimeout(timeout); resolve(); };
      });
      state.release = undefined;
      if (state.cancelled) return { stopReason: "cancelled" };
    }

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " Test turn complete." },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (state) {
      state.cancelled = true;
      state.release?.();
    }
  });

agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
