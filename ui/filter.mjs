// Snapshot-local filtering. Every field below is already visible in an authorized topology.
export function compileNodeFilter(query = "") {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map((term) => {
    const match = /^(type|state|cap):(.+)$/.exec(term);
    return match ? { field: match[1], value: match[2] } : { field: "text", value: term };
  });
  const matches = (kind, text, state, caps = []) => tokens.every(({ field, value }) => {
    if (field === "type") return kind === value;
    if (field === "state") return state.toLowerCase().includes(value);
    if (field === "cap") return kind === "worker" && caps.some((cap) => cap.toLowerCase().includes(value));
    return text.toLowerCase().includes(value);
  });
  return {
    active: tokens.length > 0,
    device: (device, state) => matches("device", `${device.name} ${device.id}`, state),
    worker: (agent, device) => matches("worker", `${device?.name ?? ""} ${device?.id ?? ""} ${agent.id} ${agent.caps.join(" ")}`, agent.state, agent.caps),
    board: (board) => matches("board", `${board.id} ${board.kind}`, board.reported ? "reported" : "local"),
  };
}

export function filteredTopology(snapshot, query, deviceState = () => "registered") {
  const filter = compileNodeFilter(query);
  if (!snapshot) return { groups: [], boards: [], filter, counts: { devices: 0, workers: 0, boards: 0 } };
  const groups = snapshot.devices.map((device) => {
    const agents = snapshot.agents.filter((agent) => agent.device === device.id && filter.worker(agent, device));
    const visible = filter.device(device, deviceState(device)) || agents.length > 0;
    return { device, agents, visible };
  }).filter((group) => group.visible);
  const boards = snapshot.boards.filter(filter.board);
  return { groups, boards, filter, counts: {
    devices: groups.length, workers: groups.reduce((total, group) => total + group.agents.length, 0), boards: boards.length,
  } };
}

export function filterSuggestions(snapshot, deviceState = () => "registered") {
  if (!snapshot) return [];
  const values = new Set(["type:device", "type:worker", "type:board"]);
  for (const device of snapshot.devices) values.add(`state:${deviceState(device)}`);
  for (const agent of snapshot.agents) {
    values.add(`state:${agent.state}`);
    for (const cap of agent.caps) values.add(`cap:${cap}`);
  }
  for (const board of snapshot.boards) values.add(`state:${board.reported ? "reported" : "local"}`);
  return [...values].filter((value) => value.length <= 128).sort().slice(0, 64);
}
