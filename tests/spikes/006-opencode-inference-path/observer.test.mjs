import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import observer from "./observer.mjs";

const nativeSession = "ses_inference_fixture";
const challenges = ["READY_0000000000000000", "DELIVERED_0000000000000000"];
const input = () => ({
  model: "openrouter/free", stream: true, max_tokens: 1024,
  messages: [{ role: "system", content: challenges.join(" ") },
    { role: "user", content: "Relay pending state changed. Fixture-only content." }],
});
const requestFor = (body = input()) => new Request("http://127.0.0.1:9/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Fixture-Private": "never-capture-this-header" },
  body: JSON.stringify(body),
});
const eventFor = (request, overrides = {}) => ({ sessionID: nativeSession, kind: "primary", agent: "relay-probe", request, ...overrides });

async function fixture(t, hook) {
  const root = await mkdtemp(join(process.env.TMPDIR, "relay-inference-observer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, "trace.json");
  const hooks = new Map();
  const cleanup = await observer.setup({
    app: { version: "2.0.27" }, options: { nativeSession, reportPath, challenges },
    session: { hook: hook ?? (async (name, callback) => {
      hooks.set(name, callback);
      return { dispose: async () => hooks.delete(name) };
    }) },
  });
  t.after(cleanup);
  return { hooks, cleanup, reportPath };
}

test("inference observer preserves native request/response bytes and excludes bodies and headers", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  await hooks.get("http.request")(eventFor(requestFor(), { sessionID: "ses_other_fixture" }));
  await hooks.get("http.request")(eventFor(requestFor(), { kind: "title" }));
  const request = requestFor();
  const event = eventFor(request);
  await hooks.get("http.request")(event);
  assert.deepEqual(await request.json(), input());
  const responseText = 'data: {"model":"fixture/model","choices":[{"delta":{"content":"fixture-only-output"}}]}\n\ndata: [DONE]\n\n';
  const response = new Response(responseText, { headers: { "Content-Type": "text/event-stream" } });
  hooks.get("http.response")({ ...event, response });
  assert.equal(await response.text(), responseText);
  const lateRequest = hooks.get("http.request");
  await cleanup();
  await lateRequest(eventFor(requestFor()));
  const raw = await readFile(reportPath, "utf8");
  const report = JSON.parse(raw);
  assert.equal(report.calls.length, 1);
  assert.equal(report.calls[0].responseModel, "fixture/model");
  assert.deepEqual(report.calls[0].request.challengesInSystem, [true, true]);
  assert.equal(report.calls[0].request.relayNotice, true);
  assert.equal(raw.includes("Fixture-only content"), false);
  assert.equal(raw.includes("fixture-only-output"), false);
  assert.equal(raw.includes("never-capture-this-header"), false);
  assert.equal(raw.includes(nativeSession), false);
});

test("inference observer bounds capture count and body size", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  const oversized = input();
  oversized.messages[0].content = "x".repeat(128 * 1024);
  const original = requestFor(oversized);
  await hooks.get("http.request")(eventFor(original));
  assert.deepEqual(await original.json(), oversized);
  for (let index = 0; index < 9; index++) await hooks.get("http.request")(eventFor(requestFor()));
  await cleanup();
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.calls.length, 8);
  assert.equal(report.calls[0].requestError, "body_limit");
});

test("inference observer rolls back earlier registration when the response hook fails", async (t) => {
  let disposed = false;
  await assert.rejects(fixture(t, async (name) => {
    if (name === "http.response") throw new Error("fixture registration failure");
    return { dispose: async () => { disposed = true; } };
  }), /fixture registration failure/);
  assert.equal(disposed, true);
});

test("inference observer reports a missing model without retaining response text", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  const event = eventFor(requestFor());
  await hooks.get("http.request")(event);
  const response = new Response('data: {"choices":[{"delta":{"content":"private-fixture-text"}}]}\n\n');
  hooks.get("http.response")({ ...event, response });
  await response.text();
  await cleanup();
  const raw = await readFile(reportPath, "utf8");
  assert.equal(JSON.parse(raw).calls[0].responseError, "model_unobserved");
  assert.equal(raw.includes("private-fixture-text"), false);
});

test("inference observer cleanup does not wait for an unconsumed original response", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  const event = eventFor(requestFor());
  await hooks.get("http.request")(event);
  let source;
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }));
  hooks.get("http.response")({ ...event, response });
  let timer;
  try {
    await Promise.race([cleanup(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Observer cleanup exceeded its deadline")), 5000);
    })]);
  } finally {
    clearTimeout(timer);
    source.close();
  }
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).calls[0].responseError, "body_deadline");
  assert.equal(await response.text(), "");
});

test("inference observer cleanup waits for an in-flight request capture", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  let source;
  const request = new Request("http://127.0.0.1:9/v1/chat/completions", {
    method: "POST", duplex: "half",
    body: new ReadableStream({ start(controller) { source = controller; } }),
  });
  const capturing = hooks.get("http.request")(eventFor(request));
  let finished = false;
  const stopping = cleanup().then(() => { finished = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "Cleanup returned before the request capture settled");
  } finally {
    source.enqueue(new TextEncoder().encode(JSON.stringify(input())));
    source.close();
    await capturing;
    await stopping;
  }
  assert.deepEqual(await request.json(), input());
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).calls[0].request.relayNotice, true);
});

test("inference observer projects bounded metadata instead of copying unexpected payload fields", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  const sentinel = "PRIVATE_METADATA_FIXTURE";
  const body = { model: { payload: sentinel }, stream: { payload: sentinel }, max_tokens: { payload: sentinel },
    messages: Array.from({ length: 70 }, () => ({ role: sentinel, content: sentinel })) };
  const original = requestFor(body);
  await hooks.get("http.request")(eventFor(original));
  await cleanup();
  assert.deepEqual(await original.json(), body);
  const raw = await readFile(reportPath, "utf8");
  assert.equal(raw.includes(sentinel), false);
  const request = JSON.parse(raw).calls[0].request;
  assert.equal(request.model, null);
  assert.equal(request.stream, null);
  assert.equal(request.maxTokens, null);
  assert.equal(request.roles.length, 64);
  assert.equal(request.messagesTruncated, true);
  assert.ok(request.roles.every((role) => role === "unknown"));
});

test("inference observer coalesces duplicate response callbacks", async (t) => {
  const { hooks, cleanup, reportPath } = await fixture(t);
  const event = eventFor(requestFor());
  await hooks.get("http.request")(event);
  const response = new Response('data: {"model":"fixture/model"}\n\n');
  const clone = response.clone.bind(response);
  let clones = 0;
  response.clone = () => { clones++; return clone(); };
  for (let index = 0; index < 20; index++) hooks.get("http.response")({ ...event, response });
  await response.text();
  await cleanup();
  assert.equal(clones, 1);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).calls[0].responseModel, "fixture/model");
});
