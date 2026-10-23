import test from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../src/graph.mjs";

const host = (id, agents = [], status = "connected") => ({
  id, label: id.toUpperCase(), state: { status }, agents,
});
const session = (hostId, resource, provider, title = resource) => ({
  hostId, hostLabel: hostId.toUpperCase(),
  summary: { resource, provider, title, workingDirectories: ["file:///work/repo"], status: 8 },
});

test("unadvertised provider still renders actual subscribed sessions and status", () => {
  const result = buildGraph([
    host("a", [{ provider: "codex", displayName: "Codex" }]),
    host("b", [], "reconnecting"),
  ], [
    session("a", "codex:/one", "codex", "Review"),
    session("a", "claude:/two", "claude", "Refactor"),
    session("b", "claude:/two", "claude", "Other"),
  ]);
  assert.equal(result.shown, 3);
  assert.equal(result.nodes.filter(({ kind }) => kind === "session").length, 3);
  assert.equal(result.edges.filter(({ chat, sessionUri }) => sessionUri).length, 3);
  const unadvertised = result.nodes.find(({ id }) => id === "a\0agent\0claude");
  assert.equal(unadvertised.advertised, false);
  assert.match(unadvertised.subtitle, /not advertised/);
  assert.equal(result.nodes.find((node) => node.kind === "session" && node.hostId === "b").subtitle, "offline");
  assert.ok(result.edges.filter((edge) => edge.hostId === "b").every((edge) => edge.stale));
  assert.equal(new Set(result.nodes.map(({ id }) => id)).size, result.nodes.length);
});

test("search and caps never create fake sessions or hide matching provider identities", () => {
  const hosts = [host("a", [{ provider: "codex", displayName: "Codex" }])];
  const rows = Array.from({ length: 30 }, (_, index) =>
    session("a", "codex:/s" + index, "codex", "Review " + index));
  const capped = buildGraph(hosts, rows, "", 16);
  assert.equal(capped.shown, 16);
  assert.equal(capped.total, 30);
  assert.equal(capped.nodes.filter((node) => node.kind === "session").length, 16);
  assert.equal(buildGraph(hosts, rows, "a codex repo", 4).shown, 4);
  assert.equal(buildGraph(hosts, [], "codex").nodes.filter((node) => node.kind === "provider").length, 1);
  assert.equal(buildGraph(hosts, rows, "no match").nodes.length, 0);
});

test("graph lanes have non-overlapping identities and bounded connector routes", () => {
  const result = buildGraph(
    [host("a", [{ provider: "codex", displayName: "Codex" }])],
    Array.from({ length: 8 }, (_, index) => session("a", "codex:/s" + index, "codex")),
  );
  const provider = result.nodes.find((node) => node.kind === "provider");
  const sessions = result.nodes.filter((node) => node.kind === "session");
  assert.ok(provider.x + provider.w < sessions[0].x);
  assert.ok(sessions.every((node) => node.x + node.w < result.width));
  for (let i = 1; i < sessions.length; i++) {
    assert.ok(sessions[i].y >= sessions[i - 1].y + sessions[i - 1].h);
  }
  assert.ok(result.edges.every((edge) => /^M \d+ \d+ H \d+ V \d+ H \d+$/.test(edge.d)));
});
