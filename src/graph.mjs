import { sessionState } from "./fleet.mjs";

const width = 900;
const positions = {
  host: { x: 24, w: 208, h: 50 },
  provider: { x: 292, w: 208, h: 46 },
  session: { x: 580, w: 296, h: 46 },
};

const match = (terms, fields) => terms.every((term) =>
  fields.some((field) => String(field ?? "").toLowerCase().includes(term)));

// Pure projection of the AHP host and session snapshots. Session providers may
// outlive the host's current agent advertisement; those sessions stay visible.
export function buildGraph(hosts, sessions, query = "", limit = 16) {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hostAgents = new Map(hosts.map((host) => [
    host.id, new Map((host.agents || []).map((agent) => [agent.provider, agent.displayName])),
  ]));
  const visible = sessions.filter(({ hostId, hostLabel, summary }) => match(terms, [
    hostId, hostLabel, summary.resource, summary.title, summary.provider,
    hostAgents.get(hostId)?.get(summary.provider), summary.activity,
    ...(summary.workingDirectories || []),
  ]));
  const shown = visible.slice(0, Math.max(0, limit));
  const nodes = [];
  const edges = [];
  let cursor = 36;

  for (const host of hosts) {
    const hostMatches = terms.length > 0 && match(terms, [
      host.id, host.label, host.state.status,
    ]);
    const matchingAgents = (host.agents || []).filter((agent) =>
      match(terms, [agent.provider, agent.displayName]));
    const visibleOnHost = visible.filter((row) => row.hostId === host.id);
    if (terms.length && !hostMatches && !visibleOnHost.length && !matchingAgents.length) continue;

    const owned = shown.filter((row) => row.hostId === host.id);
    const grouped = new Map();
    for (const row of owned) {
      const provider = row.summary.provider || "";
      if (!grouped.has(provider)) grouped.set(provider, []);
      grouped.get(provider).push(row);
    }
    const advertised = (host.agents || []).filter((agent) => !terms.length ||
      hostMatches || visibleOnHost.some((row) => row.summary.provider === agent.provider) ||
      match(terms, [agent.provider, agent.displayName]));
    const providers = advertised.map((agent) => ({ ...agent, advertised: true }));
    for (const provider of grouped.keys()) {
      if (!providers.some((agent) => agent.provider === provider)) {
        providers.push({ provider, displayName: provider || "Unknown agent", advertised: false });
      }
    }

    const first = cursor;
    const centers = [];
    for (const agent of providers) {
      const rows = grouped.get(agent.provider) || [];
      const span = Math.max(1, rows.length) * 62;
      const center = cursor + span / 2;
      const providerId = host.id + "\0agent\0" + agent.provider;
      const agentNode = {
        id: providerId, kind: "provider", hostId: host.id,
        x: positions.provider.x, y: center - positions.provider.h / 2,
        w: positions.provider.w, h: positions.provider.h,
        title: agent.displayName || agent.provider || "Unknown agent",
        subtitle: agent.advertised ? (agent.provider || "Unspecified") : "Session provider · not advertised",
        status: host.state.status, advertised: agent.advertised,
      };
      nodes.push(agentNode);
      centers.push(center);

      for (const [index, row] of rows.entries()) {
        const y = cursor + index * 62 + 8;
        const sessionNode = {
          id: host.id + "\0" + row.summary.resource,
          kind: "session", hostId: host.id, uri: row.summary.resource,
          x: positions.session.x, y, w: positions.session.w, h: positions.session.h,
          title: row.summary.title || row.summary.provider || "Untitled session",
          subtitle: sessionState(row.summary, host.state.status === "connected"),
          status: sessionState(row.summary, host.state.status === "connected"),
          chat: row.summary.defaultChat || row.summary.chats?.[0]?.resource,
        };
        nodes.push(sessionNode);
        edges.push({
          hostId: host.id, from: providerId, to: sessionNode.id,
          sessionUri: sessionNode.uri, chat: sessionNode.chat,
          stale: host.state.status !== "connected",
          d: path(agentNode.x + agentNode.w, center,
            sessionNode.x, y + sessionNode.h / 2),
        });
      }
      cursor += span + 12;
    }

    const center = centers.length ? (centers[0] + centers.at(-1)) / 2 : first + 25;
    const hostNode = {
      id: host.id, kind: "host", hostId: host.id,
      x: positions.host.x, y: center - positions.host.h / 2,
      w: positions.host.w, h: positions.host.h,
      title: host.label, subtitle: host.state.status, status: host.state.status,
    };
    nodes.push(hostNode);
    for (const providerCenter of centers) {
      const agent = nodes.find((node) => node.kind === "provider" &&
        node.hostId === host.id && node.y + node.h / 2 === providerCenter);
      edges.push({
        hostId: host.id, from: host.id, to: agent.id,
        stale: host.state.status !== "connected",
        d: path(hostNode.x + hostNode.w, center, agent.x, providerCenter),
      });
    }
    cursor += providers.length ? 28 : 68;
  }

  return {
    nodes, edges, width, height: Math.max(176, cursor + 12),
    shown: shown.length, total: visible.length,
  };
}

function path(x1, y1, x2, y2) {
  const mx = Math.round((x1 + x2) / 2);
  return `M ${x1} ${y1} H ${mx} V ${y2} H ${x2}`;
}
