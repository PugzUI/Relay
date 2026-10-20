// tests/ui-console-render.test.mjs
//
// A durable render carrier for ui/console.mjs.
//
// ANCHORING RULE
// Every assertion below is bound to a DISTINCT input field of the fixture, and the expected
// value is DERIVED FROM THE INPUT (or from a committed golden literal) - never copied out of
// the subject's own rendered output. An expectation copied from the rendered output is a
// copy-trap: it is blind, by construction, to the class of defect where the subject publishes
// a wrong value at several sites at once, because the sites still agree with each other.
//
// GATES
//   1. BASELINE     every anchored assertion passes against the unmodified subject.
//   2. NON-VACUITY  every named mutant fails the assertion it targets, and fails exactly the
//                   declared set. The number of source sites each mutant changes is declared
//                   and measured; a mutant that changes the declared sites and is caught by
//                   nothing is a HOLE.
//   3. CENSUS       the published sites of the asserted value are enumerated from the
//                   subject's own baseline output. Every occurrence must fall inside a
//                   declared, anchored site, and every single-site mutant must be caught by
//                   an input-anchored assertion. A hole is an EXIT CODE (6), never an
//                   opinion about the output.
//
// The supplementary self-comparison (topology_sites_agree) is NEVER counted as coverage: it
// covers a site only accidentally, namely when the OTHER site does not move.
//
// The lossy-dimension controls stay out of this file: they need a projection capture, and
// this file never asserts on the shape of a capture.
//
// DROPPED CASES, NAMED (a removed case is a silent weakening, so nothing is dropped
// silently; each entry names the case id that covers it, or the scope that excludes it):
//   name_row_copy_trap   -> replaced by A_name_row. The copy-trap compared the subject's
//                           output against itself and is blind to a multi-site defect by
//                           construction; it is not carried as coverage.
//   name_row_projection  -> A_name_row for the contract-visible dimension. The lossy
//                           dimension (the lossless projection of a value) needs a
//                           projection capture and stays in the /tmp harness.
//   map_value / map_name -> DEFERRED by the owner: the optional Map-name fixture.
//   path_geometry        -> out of scope: the topology layout is not part of this
//                           carrier's contract.
//   focus_arrow_up       -> out of scope: keyboard navigation is not part of this
//                           carrier's contract.
//
// THE SET MOVED, IT WAS NOT RETRACTED: the census finding that the collapse-label site was
// covered by nothing was made against a set that had no collapse-site assertion. This file
// adds A_collapse_aria, and that assertion is what catches the collapseLabelOnly mutant
// now. The set grew; the finding stands.
//
// Liveness switches (inert unless the variable is set):
//   RELAY_CARRIER_INJECT_HOLE=1  the census treats the topology.collapse site as unanchored,
//                                 which must end the run with exit code 6.
//   RELAY_CARRIER_INJECT_UNCAUGHT=1
//                                 a mutant that changes a site the carrier does not assert
//                                 on is added to the population, so the mutant gate must
//                                 end the run with exit code 6.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUBJECT_FILE = join(ROOT, "ui", "console.mjs");
const FILTER_FILE = join(ROOT, "ui", "filter.mjs");
const SUBJECT_SOURCE = readFileSync(SUBJECT_FILE, "utf8");
const NOTHING = Symbol("nothing");

// The fixture is the public input of the subject: the snapshot a relay publishes. Every
// assertion below is bound to one field of it.
const SNAPSHOT = {
  authority: "hub:1",
  time: 1700000000000,
  totals: { devices: 2, agents: 3, boards: 2 },
  visible: { devices: 2, agents: 3, boards: 2 },
  devices: [
    {
      id: "host:a",
      name: "alpha",
      init: 1699999999000,
      authority: "hub:1",
      receivedAt: 1699999999500,
      stale: false,
      free: 2,
    },
    {
      id: "host:b",
      name: "beta",
      init: 1699999999000,
      authority: "other:2",
      receivedAt: 1699999998000,
      stale: true,
      free: null,
    },
  ],
  agents: [
    {
      id: "host:a:worker:001",
      device: "host:a",
      runtime: "opencode",
      slot: "001",
      state: "busy",
      caps: ["verify"],
      assignmentCount: 1,
      epoch: 3,
      receivedAt: 1699999999500,
      init: 1699999999000,
    },
    {
      id: "host:a:worker:002",
      device: "host:a",
      runtime: "opencode",
      slot: "prime",
      state: "idle",
      caps: [],
      assignmentCount: 0,
      epoch: 1,
      receivedAt: null,
      init: 1699999999000,
    },
    {
      id: "host:b:worker:001",
      device: "host:b",
      runtime: "claude",
      slot: "002",
      state: "stale",
      caps: ["deploy"],
      assignmentCount: 2,
      epoch: 5,
      receivedAt: 1699999998000,
      init: 1699999999000,
    },
  ],
  boards: [
    {
      id: "bounty",
      kind: "bounty",
      reported: true,
      authority: "hub:1",
      inbox: 2,
      pending: 1,
      claimed: 0,
      terminal: 0,
      receivedAt: 1699999999500,
      init: 1699999999000,
    },
    {
      id: "host:local",
      kind: "host",
      reported: false,
      authority: "hub:1",
      inbox: 0,
      pending: 0,
      claimed: 0,
      terminal: 1,
      receivedAt: null,
      init: 1699999999000,
    },
  ],
  links: [
    { id: "l1", from: "host:a", to: "host:a:worker:001", kind: "assignment", state: "active" },
    { id: "l2", from: "host:b", to: "host:b:worker:001", kind: "assignment", state: "uncertain" },
  ],
};

const DEVICE = SNAPSHOT.devices[0];
const STALE_DEVICE = SNAPSHOT.devices[1];
const WORKER = SNAPSHOT.agents[0];
const BOARD = SNAPSHOT.boards[0];

// The carrier loads the subject into a stubbed browser context. The loader transform is
// corpus-validated: see "the loader transform keeps every tracked file parseable".
function stripImports(source) {
  const lines = source.split("\n");
  const kept = [];
  let importing = false;
  for (const line of lines) {
    if (!importing && /^\s*import(?![(.])/.test(line)) {
      importing = !/["']/.test(line);
      continue;
    }
    if (importing) {
      if (/["']/.test(line)) importing = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// The naive per-line import strip, kept only as the measured contrast for the corpus check.
function stripImportsNaive(source) {
  return source.replace(/^import .*$/gm, "");
}

function makeContext() {
  const classes = new Map();
  class LitElement {
    createRenderRoot() {
      return this;
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
  }
  const template = (strings, ...values) => ({ strings, values });
  const context = vm.createContext({
    LitElement,
    html: template,
    svg: template,
    nothing: NOTHING,
    repeat: (items, _key, fn) => items.map(fn),
    customElements: {
      define: (name, klass) => classes.set(name, klass),
    },
    CustomEvent: class CustomEventStub {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
    window: { addEventListener() {}, removeEventListener() {} },
    console,
  });
  vm.runInContext(readFileSync(FILTER_FILE, "utf8").replace(/^export /gm, ""), context);
  return { classes, context };
}

function buildSubject(source) {
  const { classes, context } = makeContext();
  vm.runInContext(stripImports(source), context);
  return classes;
}

function renderText(value) {
  if (value === NOTHING || value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(renderText).join("");
  if (typeof value === "object" && Array.isArray(value.strings)) {
    let text = "";
    for (let index = 0; index < value.strings.length; index += 1) {
      text += value.strings[index];
      if (index < value.values.length) text += renderText(value.values[index]);
    }
    return text;
  }
  return String(value);
}

function renderInspector(classes, snapshot, selection) {
  const Inspector = classes.get("relay-inspector");
  const element = new Inspector();
  element.snapshot = snapshot;
  element.selection = selection;
  element.query = "";
  element.connection = "connected";
  return renderText(element.render());
}

function stubGeometry(element) {
  const surface = {
    getBoundingClientRect: () => ({
      left: 5,
      top: 7,
      width: 800,
      height: 600,
      right: 805,
      bottom: 607,
    }),
  };
  const nodes = [
    {
      dataset: { entity: "host:a" },
      getBoundingClientRect: () => ({
        left: 20,
        top: 30,
        width: 100,
        height: 40,
        right: 120,
        bottom: 70,
      }),
    },
    {
      dataset: { entity: "host:a:worker:001" },
      getBoundingClientRect: () => ({
        left: 200,
        top: 200,
        width: 100,
        height: 40,
        right: 300,
        bottom: 240,
      }),
    },
    {
      dataset: { board: "bounty" },
      getBoundingClientRect: () => ({
        left: 400,
        top: 30,
        width: 100,
        height: 40,
        right: 500,
        bottom: 70,
      }),
    },
  ];
  element.querySelector = (selector) => {
    if (selector === ".topology-surface") return surface;
    if (selector === ".topology-svg") return { setAttribute: () => {} };
    return null;
  };
  element.querySelectorAll = () => nodes;
}

function renderTopology(classes, snapshot) {
  const Topology = classes.get("relay-topology");
  const element = new Topology();
  element.snapshot = snapshot;
  element.selectedBoard = null;
  element.selectedNode = null;
  element.pulses = [];
  element.query = "";
  element.connection = "connected";
  stubGeometry(element);
  return renderText(element.render());
}

function rowsOf(flat) {
  const rows = new Map();
  for (const match of flat.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)) {
    rows.set(match[1], match[2]);
  }
  return rows;
}

function observe(classes, snapshot = SNAPSHOT) {
  const device = renderInspector(classes, snapshot, DEVICE.id);
  const stale = renderInspector(classes, snapshot, STALE_DEVICE.id);
  const worker = renderInspector(classes, snapshot, WORKER.id);
  const board = renderInspector(classes, snapshot, BOARD.id);
  const topology = renderTopology(classes, snapshot);
  return {
    deviceFlat: device,
    staleFlat: stale,
    workerFlat: worker,
    boardFlat: board,
    topologyFlat: topology,
    deviceRows: rowsOf(device),
    staleRows: rowsOf(stale),
    workerRows: rowsOf(worker),
    boardRows: rowsOf(board),
  };
}

function branchName(topologyFlat) {
  const match = topologyFlat.match(/data-device=host:a aria-label=([^>]*)>/);
  return match ? match[1] : null;
}

function deviceNodeName(topologyFlat) {
  const match = topologyFlat.match(
    /data-entity=host:a aria-pressed=[\s\S]{0,400}?<span class="node-name">([^<]*)<\/span>/,
  );
  return match ? match[1] : null;
}

function collapseLabel(topologyFlat) {
  const match = topologyFlat.match(
    /data-collapse=host:a[^>]*aria-label=(Collapse [^ ]*) aria-expanded=/,
  );
  return match ? match[1] : null;
}

// Every assertion is anchored on an input field of the fixture, or on a committed golden
// literal. `anchored: false` marks the one supplementary self-comparison, which is never
// counted as coverage of a published site.
const ASSERTIONS = [
  {
    key: "A_name_row",
    site: "inspector.Name",
    binding: "devices[host:a].name",
    label: "device inspector Name row",
    anchored: true,
    check: (out) => out.deviceRows.get("Name") === DEVICE.name,
  },
  {
    key: "A_authority_row",
    site: "inspector.Authority",
    binding: "devices[host:a].authority",
    label: "device inspector Authority row",
    anchored: true,
    check: (out) => out.deviceRows.get("Authority") === DEVICE.authority,
  },
  {
    key: "A_device_state_row",
    site: "inspector.State",
    binding: "devices[host:a].stale === false",
    label: "fresh device inspector State row",
    anchored: true,
    check: (out) => out.deviceRows.get("State") === "registered",
  },
  {
    key: "A_free_slots_row",
    site: "inspector.FreeSlots",
    binding: "devices[host:a].free",
    label: "fresh device inspector Free slots row",
    anchored: true,
    check: (out) => out.deviceRows.get("Free slots") === String(DEVICE.free),
  },
  {
    key: "A_stale_state_row",
    site: "inspector.State(stale)",
    binding: "devices[host:b].stale === true",
    label: "stale device inspector State row",
    anchored: true,
    check: (out) => out.staleRows.get("State") === "stale",
  },
  {
    key: "A_free_slots_unknown",
    site: "inspector.FreeSlots(stale)",
    binding: "devices[host:b].free === null",
    label: "stale device inspector Free slots row",
    anchored: true,
    check: (out) => out.staleRows.get("Free slots") === "unknown",
  },
  {
    key: "A_agent_device_row",
    site: "inspector.Device",
    binding: "agents[host:a:worker:001].device -> devices[host:a].name",
    label: "worker inspector Device row",
    anchored: true,
    check: (out) => out.workerRows.get("Device") === DEVICE.name,
  },
  {
    key: "A_agent_runtime_row",
    site: "inspector.Runtime",
    binding: "agents[host:a:worker:001].runtime",
    label: "worker inspector Runtime row",
    anchored: true,
    check: (out) => out.workerRows.get("Runtime") === WORKER.runtime,
  },
  {
    key: "A_agent_slot_row",
    site: "inspector.Slot",
    binding: "agents[host:a:worker:001].slot",
    label: "worker inspector Slot row",
    anchored: true,
    check: (out) => out.workerRows.get("Slot") === WORKER.slot,
  },
  {
    key: "A_agent_epoch_row",
    site: "inspector.Epoch",
    binding: "agents[host:a:worker:001].epoch",
    label: "worker inspector Epoch row",
    anchored: true,
    check: (out) => out.workerRows.get("Epoch") === String(WORKER.epoch),
  },
  {
    key: "A_agent_state_row",
    site: "inspector.State(worker)",
    binding: "agents[host:a:worker:001].state",
    label: "worker inspector State row",
    anchored: true,
    check: (out) => out.workerRows.get("State") === WORKER.state,
  },
  {
    key: "A_agent_caps_row",
    site: "inspector.Capabilities",
    binding: "agents[host:a:worker:001].caps",
    label: "worker inspector Capabilities row",
    anchored: true,
    check: (out) => out.workerRows.get("Capabilities") === WORKER.caps.join(", "),
  },
  {
    key: "A_agent_assignments_row",
    site: "inspector.Assignments",
    binding: "agents[host:a:worker:001].assignmentCount",
    label: "worker inspector Assignments row",
    anchored: true,
    check: (out) => out.workerRows.get("Assignments") === String(WORKER.assignmentCount),
  },
  {
    key: "A_board_kind_row",
    site: "inspector.Kind",
    binding: "boards[bounty].kind",
    label: "board inspector Kind row",
    anchored: true,
    check: (out) => out.boardRows.get("Kind") === BOARD.kind,
  },
  {
    key: "A_board_source_row",
    site: "inspector.Source",
    binding: "boards[bounty].reported",
    label: "board inspector Source row",
    anchored: true,
    check: (out) => out.boardRows.get("Source") === (BOARD.reported ? "reported" : "local"),
  },
  {
    key: "A_board_authority_row",
    site: "inspector.Authority(board)",
    binding: "boards[bounty].authority",
    label: "board inspector Authority row",
    anchored: true,
    check: (out) => out.boardRows.get("Authority") === BOARD.authority,
  },
  {
    key: "A_board_inbox_row",
    site: "inspector.Inbox",
    binding: "boards[bounty].inbox",
    label: "board inspector Inbox row",
    anchored: true,
    check: (out) => out.boardRows.get("Inbox") === String(BOARD.inbox),
  },
  {
    key: "A_board_pending_row",
    site: "inspector.Pending",
    binding: "boards[bounty].pending",
    label: "board inspector Pending row",
    anchored: true,
    check: (out) => out.boardRows.get("Pending") === String(BOARD.pending),
  },
  {
    key: "A_board_claimed_row",
    site: "inspector.Claimed",
    binding: "boards[bounty].claimed",
    label: "board inspector Claimed row",
    anchored: true,
    check: (out) => out.boardRows.get("Claimed") === String(BOARD.claimed),
  },
  {
    key: "A_board_terminal_row",
    site: "inspector.Terminal",
    binding: "boards[bounty].terminal",
    label: "board inspector Terminal row",
    anchored: true,
    check: (out) => out.boardRows.get("Terminal") === String(BOARD.terminal),
  },
  {
    key: "A_eyebrow",
    site: "inspector.eyebrow",
    binding: "golden: the selected entity kind",
    label: "device inspector identity eyebrow",
    anchored: true,
    check: (out) => out.deviceFlat.includes('<span class="eyebrow">Device</span>'),
  },
  {
    key: "A_topology_label",
    site: "topology.device-lane.heading",
    binding: "golden: the device lane heading",
    label: "topology device lane heading",
    anchored: true,
    check: (out) => out.topologyFlat.includes('<h3 class="topology-label">Devices / Workers</h3>'),
  },
  {
    key: "A_topology_aria",
    site: "topology.branch",
    binding: "devices[host:a].name",
    label: "topology device branch aria-label",
    anchored: true,
    check: (out) => branchName(out.topologyFlat) === DEVICE.name,
  },
  {
    key: "A_topology_node_name",
    site: "topology.device-node",
    binding: "devices[host:a].name",
    label: "topology device node name",
    anchored: true,
    check: (out) => deviceNodeName(out.topologyFlat) === DEVICE.name,
  },
  {
    key: "A_collapse_aria",
    site: "topology.collapse",
    binding: "devices[host:a].name",
    label: "topology collapse control aria-label",
    anchored: true,
    check: (out) => collapseLabel(out.topologyFlat) === `Collapse ${DEVICE.name}`,
  },
  {
    key: "A_topology_sites_agree",
    site: "topology.self-comparison",
    binding: "none: compares two published sites with each other",
    label: "supplementary: the branch label and the device node name agree",
    anchored: false,
    check: (out) => branchName(out.topologyFlat) === deviceNodeName(out.topologyFlat),
  },
];

// The published sites of the asserted value, as they appear in the subject's own output. The
// census uses these to require that every published occurrence is anchored.
const PUBLISHED_SITES = [
  { site: "inspector.Name", output: "device", pattern: `<dt>Name</dt><dd>${DEVICE.name}</dd>` },
  {
    site: "inspector.Device",
    output: "worker",
    pattern: `<dt>Device</dt><dd>${DEVICE.name}</dd>`,
  },
  { site: "topology.branch", output: "topology", pattern: `aria-label=${DEVICE.name}>` },
  {
    site: "topology.device-node",
    output: "topology",
    pattern: `<span class="node-name">${DEVICE.name}</span>`,
  },
  {
    site: "topology.collapse",
    output: "topology",
    pattern: `aria-label=Collapse ${DEVICE.name} aria-expanded=`,
  },
];

// The fields this carrier deliberately does NOT pin, with the reason. Each one is present in
// the baseline output, so the declaration cannot go stale without the test noticing.
const DECLARED_UNPINNED = [
  {
    output: "deviceRows",
    label: "Report age",
    reason:
      "derived by the subject from receivedAt and snapshot.time; pinning it would re-implement the subject's derivation",
  },
  {
    output: "deviceRows",
    label: "Created · UTC",
    reason: "derived by the subject from the device init timestamp",
  },
  {
    output: "workerRows",
    label: "Report age",
    reason: "derived by the subject from receivedAt, snapshot.time and the device authority",
  },
  {
    output: "workerRows",
    label: "Created · UTC",
    reason: "derived by the subject from the agent init timestamp",
  },
  {
    output: "boardRows",
    label: "Report age",
    reason: "derived by the subject from receivedAt, snapshot.time and the reported flag",
  },
  {
    output: "topology",
    label: "node-detail",
    reason:
      "composite text mixing worker counts, free slots and a derived age; pinning it would re-implement the composition",
  },
  {
    output: "topology",
    label: "node-state",
    reason:
      "the registered/stale word, already covered through the inspector rows of the same input flag",
  },
];

// A mutant declares the source sites it changes and the assertions it must fail. `direction`
// is exactly "flag" (the mutant must be caught) or "ignore" (the mutant must change the
// subject without changing anything the carrier asserts). Any other label is a hard error at
// load time: a mislabelled case loses the ability to fail, which is worse than no case.
const MUTANT_DIRECTIONS = new Set(["flag", "ignore"]);

function assertDirection(direction) {
  if (!MUTANT_DIRECTIONS.has(direction)) {
    throw new Error(
      `mutant direction must be "flag" or "ignore", got ${JSON.stringify(direction)} - a mislabelled case is a hard error, never a fallback to ignore`,
    );
  }
}

// An independently written expectation map: one direction per mutant id. It is written by
// hand and is NOT derived from the mutant table, so a mislabelled entry cannot agree with
// itself: the table has to match the map, entry by entry, at load time.
const EXPECTED_DIRECTIONS = {
  inspector: "flag",
  topology: "flag",
  valueInspector: "flag",
  valueTopology: "flag",
  valueNumber: "flag",
  fieldLabelSingle: "flag",
  nameSwap: "flag",
  stateRow: "flag",
  deviceStateLive: "flag",
  freeSlotsUnknown: "flag",
  agentRuntime: "flag",
  agentSlot: "flag",
  agentEpoch: "flag",
  agentState: "flag",
  agentCaps: "flag",
  agentAssignments: "flag",
  boardKind: "flag",
  boardSource: "flag",
  boardAuthority: "flag",
  boardInbox: "flag",
  boardPending: "flag",
  boardClaimed: "flag",
  boardTerminal: "flag",
  deviceAuthority: "flag",
  topologyCoMove: "flag",
  nodeNameOnly: "flag",
  collapseLabelOnly: "flag",
  nameCoMoveAll: "flag",
  inertComment: "ignore",
};

function assertExpectationMap(mutants) {
  const ids = mutants.map((mutant) => mutant.name);
  const missing = ids.filter((id) => !(id in EXPECTED_DIRECTIONS));
  const extra = Object.keys(EXPECTED_DIRECTIONS).filter((id) => !ids.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `the expectation map does not match the mutant table: missing ${missing.join(",")}, extra ${extra.join(",")}`,
    );
  }
  for (const mutant of mutants) {
    const expected = EXPECTED_DIRECTIONS[mutant.name];
    if (mutant.direction !== expected) {
      throw new Error(
        `mutant ${mutant.name} is labelled ${JSON.stringify(mutant.direction)}, the expectation map says ${JSON.stringify(expected)}`,
      );
    }
  }
}

// The subject's own template placeholders are reproduced verbatim in the mutant strings
// below. A template literal with an escaped "\${" writes a placeholder without escape noise;
// the collapse label nests a template literal, so it is written as an interpolation.
const SUBJECT_ARIA_NAME = `aria-label=\${device.name}>`;
const SUBJECT_ARIA_NAME_MUT = `aria-label=\${device.name + "MUT"}>`;
const SUBJECT_NODE_NAME = `<span class="node-name">\${device.name}</span>`;
const SUBJECT_NODE_NAME_MUT = `<span class="node-name">\${device.name + "MUT"}</span>`;
const BACKTICK = "`";
const SUBJECT_COLLAPSE_ARIA = `aria-label=\${${BACKTICK}\${collapsed ? "Expand" : "Collapse"} \${device.name}${BACKTICK}}`;
const SUBJECT_COLLAPSE_ARIA_MUT = `aria-label=\${${BACKTICK}\${collapsed ? "Expand" : "Collapse"} \${device.name + "MUT"}${BACKTICK}}`;

const MUTANTS = [
  {
    name: "inspector",
    description: "the inspector eyebrow reports the entity kind as Node instead of Device",
    direction: "flag",
    edits: [
      {
        from: '  if (target.board) return "Board";\n  return "Device";',
        to: '  if (target.board) return "Board";\n  return "Node";',
        count: 1,
      },
    ],
    catches: ["A_eyebrow"],
  },
  {
    name: "topology",
    description: "the device lane heading loses the worker half of its label",
    direction: "flag",
    edits: [
      {
        from: '<h3 class="topology-label">Devices / Workers</h3>',
        to: '<h3 class="topology-label">Devices</h3>',
        count: 1,
      },
    ],
    catches: ["A_topology_label"],
  },
  {
    name: "valueInspector",
    description: "the inspector Name row publishes a value that is not the device name",
    direction: "flag",
    edits: [
      { from: '    ["Name", device.name],', to: '    ["Name", device.name + "MUT"],', count: 1 },
    ],
    catches: ["A_name_row"],
  },
  {
    name: "valueTopology",
    description: "the topology branch publishes a value that is not the device name",
    direction: "flag",
    edits: [
      {
        from: SUBJECT_ARIA_NAME,
        to: SUBJECT_ARIA_NAME_MUT,
        count: 1,
      },
    ],
    catches: ["A_topology_aria", "A_topology_sites_agree"],
  },
  {
    name: "valueNumber",
    description: "the inspector Free slots row publishes a count that is not the free slot count",
    direction: "flag",
    edits: [
      {
        from: '    ["Free slots", fresh ? count(device.free) : "unknown"],',
        to: '    ["Free slots", fresh ? 7 : "unknown"],',
        count: 1,
      },
    ],
    catches: ["A_free_slots_row"],
  },
  {
    name: "fieldLabelSingle",
    description: "the worker Device row publishes the device id instead of the device name",
    direction: "flag",
    edits: [
      {
        from: '    ["Device", device?.name ?? agent.device],',
        to: '    ["Device", agent.device],',
        count: 1,
      },
    ],
    catches: ["A_agent_device_row"],
  },
  {
    name: "nameSwap",
    description: "the device Name and Authority rows exchange their values",
    direction: "flag",
    edits: [
      { from: '    ["Name", device.name],', to: '    ["Name", device.authority],', count: 1 },
      {
        from: '    ["Authority", device.authority],',
        to: '    ["Authority", device.name],',
        count: 1,
      },
    ],
    catches: ["A_name_row", "A_authority_row"],
  },
  {
    name: "stateRow",
    description: "the stale device State row reports registered",
    direction: "flag",
    edits: [
      {
        from: '    ["State", fresh ? "registered" : "stale"],',
        to: '    ["State", "registered"],',
        count: 1,
      },
    ],
    catches: ["A_stale_state_row"],
  },
  {
    name: "deviceStateLive",
    description: "the fresh device State row reports live instead of registered",
    direction: "flag",
    edits: [
      {
        from: '    ["State", fresh ? "registered" : "stale"],',
        to: '    ["State", fresh ? "live" : "stale"],',
        count: 1,
      },
    ],
    catches: ["A_device_state_row"],
  },
  {
    name: "freeSlotsUnknown",
    description: "the stale device Free slots row reports a count instead of unknown",
    direction: "flag",
    edits: [
      {
        from: '    ["Free slots", fresh ? count(device.free) : "unknown"],',
        to: '    ["Free slots", fresh ? count(device.free) : "0"],',
        count: 1,
      },
    ],
    catches: ["A_free_slots_unknown"],
  },
  {
    name: "agentRuntime",
    description: "the worker Runtime row publishes the slot instead of the runtime",
    direction: "flag",
    edits: [
      { from: '    ["Runtime", agent.runtime],', to: '    ["Runtime", agent.slot],', count: 1 },
    ],
    catches: ["A_agent_runtime_row"],
  },
  {
    name: "agentSlot",
    description: "the worker Slot row publishes the runtime instead of the slot",
    direction: "flag",
    edits: [{ from: '    ["Slot", agent.slot],', to: '    ["Slot", agent.runtime],', count: 1 }],
    catches: ["A_agent_slot_row"],
  },
  {
    name: "agentEpoch",
    description: "the worker Epoch row publishes a different epoch",
    direction: "flag",
    edits: [
      { from: '    ["Epoch", agent.epoch],', to: '    ["Epoch", agent.epoch + 1],', count: 1 },
    ],
    catches: ["A_agent_epoch_row"],
  },
  {
    name: "agentState",
    description: "the worker State row publishes a different state",
    direction: "flag",
    edits: [{ from: '    ["State", agent.state],', to: '    ["State", "idle"],', count: 1 }],
    catches: ["A_agent_state_row"],
  },
  {
    name: "agentCaps",
    description: "the worker Capabilities row publishes no capabilities",
    direction: "flag",
    edits: [
      {
        from: '    ["Capabilities", agent.caps.join(", ") || "none"],',
        to: '    ["Capabilities", "none"],',
        count: 1,
      },
    ],
    catches: ["A_agent_caps_row"],
  },
  {
    name: "agentAssignments",
    description: "the worker Assignments row publishes no assignments",
    direction: "flag",
    edits: [
      {
        from: '    ["Assignments", agent.assignmentCount],',
        to: '    ["Assignments", 0],',
        count: 1,
      },
    ],
    catches: ["A_agent_assignments_row"],
  },
  {
    name: "boardKind",
    description: "the board Kind row publishes a different kind",
    direction: "flag",
    edits: [{ from: '    ["Kind", board.kind],', to: '    ["Kind", "host"],', count: 1 }],
    catches: ["A_board_kind_row"],
  },
  {
    name: "boardSource",
    description: "the board Source row publishes local instead of reported",
    direction: "flag",
    edits: [
      {
        from: '    ["Source", board.reported ? "reported" : "local"],',
        to: '    ["Source", "local"],',
        count: 1,
      },
    ],
    catches: ["A_board_source_row"],
  },
  {
    name: "boardAuthority",
    description: "the board Authority row publishes a different authority",
    direction: "flag",
    edits: [
      { from: '    ["Authority", board.authority],', to: '    ["Authority", "hub:9"],', count: 1 },
    ],
    catches: ["A_board_authority_row"],
  },
  {
    name: "boardInbox",
    description: "the board Inbox row publishes a different count",
    direction: "flag",
    edits: [{ from: '    ["Inbox", board.inbox],', to: '    ["Inbox", 0],', count: 1 }],
    catches: ["A_board_inbox_row"],
  },
  {
    name: "boardPending",
    description: "the board Pending row publishes a different count",
    direction: "flag",
    edits: [{ from: '    ["Pending", board.pending],', to: '    ["Pending", 0],', count: 1 }],
    catches: ["A_board_pending_row"],
  },
  {
    name: "boardClaimed",
    description: "the board Claimed row publishes a different count",
    direction: "flag",
    edits: [{ from: '    ["Claimed", board.claimed],', to: '    ["Claimed", 1],', count: 1 }],
    catches: ["A_board_claimed_row"],
  },
  {
    name: "boardTerminal",
    description: "the board Terminal row publishes a different count",
    direction: "flag",
    edits: [{ from: '    ["Terminal", board.terminal],', to: '    ["Terminal", 1],', count: 1 }],
    catches: ["A_board_terminal_row"],
  },
  {
    name: "deviceAuthority",
    description: "the device Authority row publishes a different authority",
    direction: "flag",
    edits: [
      { from: '    ["Authority", device.authority],', to: '    ["Authority", "hub:9"],', count: 1 },
    ],
    catches: ["A_authority_row"],
  },
  {
    name: "topologyCoMove",
    description: "the branch label and the device node name move together, away from the input",
    direction: "flag",
    edits: [
      {
        from: SUBJECT_ARIA_NAME,
        to: SUBJECT_ARIA_NAME_MUT,
        count: 1,
      },
      {
        from: SUBJECT_NODE_NAME,
        to: SUBJECT_NODE_NAME_MUT,
        count: 1,
      },
    ],
    catches: ["A_topology_aria", "A_topology_node_name"],
  },
  {
    name: "nodeNameOnly",
    description: "only the device node name moves away from the input",
    direction: "flag",
    edits: [
      {
        from: SUBJECT_NODE_NAME,
        to: SUBJECT_NODE_NAME_MUT,
        count: 1,
      },
    ],
    catches: ["A_topology_node_name", "A_topology_sites_agree"],
  },
  {
    name: "collapseLabelOnly",
    description: "only the collapse control label moves away from the input",
    direction: "flag",
    edits: [
      {
        from: SUBJECT_COLLAPSE_ARIA,
        to: SUBJECT_COLLAPSE_ARIA_MUT,
        count: 1,
      },
    ],
    catches: ["A_collapse_aria"],
  },
  {
    name: "nameCoMoveAll",
    description: "every published site of the device name moves together, away from the input",
    direction: "flag",
    edits: [
      { from: '    ["Name", device.name],', to: '    ["Name", device.name + "MUT"],', count: 1 },
      {
        from: '    ["Device", device?.name ?? agent.device],',
        to: '    ["Device", (device?.name ?? agent.device) + "MUT"],',
        count: 1,
      },
      {
        from: SUBJECT_ARIA_NAME,
        to: SUBJECT_ARIA_NAME_MUT,
        count: 1,
      },
      {
        from: SUBJECT_NODE_NAME,
        to: SUBJECT_NODE_NAME_MUT,
        count: 1,
      },
      {
        from: SUBJECT_COLLAPSE_ARIA,
        to: SUBJECT_COLLAPSE_ARIA_MUT,
        count: 1,
      },
    ],
    catches: [
      "A_name_row",
      "A_agent_device_row",
      "A_topology_aria",
      "A_topology_node_name",
      "A_collapse_aria",
    ],
  },
  {
    name: "inertComment",
    description: "a comment in the subject source changes nothing the carrier asserts on",
    direction: "ignore",
    edits: [
      {
        from: "const MAX_VISIBLE_WORKERS = 24;",
        to: "const MAX_VISIBLE_WORKERS = 24;\n// inert control: a comment changes no published value.",
        count: 1,
      },
    ],
    catches: [],
  },
];

// The single-site mutants: one per published site of the asserted value. The census requires
// each of them to be caught by an input-anchored assertion.
const SINGLE_SITE_MUTANTS = [
  "valueInspector",
  "fieldLabelSingle",
  "valueTopology",
  "nodeNameOnly",
  "collapseLabelOnly",
];

const DECLARED_ASSERTION_COUNT = 26;
const DECLARED_MUTANT_COUNT = 29;

for (const mutant of MUTANTS) assertDirection(mutant.direction);
// The table has to agree with the independently written expectation map, entry by entry.
assertExpectationMap(MUTANTS);

function applyMutant(source, mutant) {
  let mutated = source;
  const applied = [];
  for (const edit of mutant.edits) {
    const parts = mutated.split(edit.from);
    applied.push(parts.length - 1);
    mutated = parts.join(edit.to);
  }
  return { source: mutated, applied };
}

function failingAssertions(observation) {
  return ASSERTIONS.filter((assertion) => !assertion.check(observation)).map(
    (assertion) => assertion.key,
  );
}

// The mutant gate reads `direction` from the mutant table - the same field the table
// declares - and it reads `catches` from that same table. Every declared guard is
// consulted here; a guard that is declared and never read would be the inert-case trap.
function mutantEditFailures(source, mutant, applied) {
  const failures = [];
  if (applied.source === source) {
    failures.push(`${mutant.name}: the edits do not change the source`);
    return failures;
  }
  applied.applied.forEach((count, index) => {
    if (count !== mutant.edits[index].count) {
      failures.push(
        `${mutant.name}: edit ${index} changed ${count} sites, declared ${mutant.edits[index].count}`,
      );
    }
  });
  return failures;
}

function mutantDirectionFailures(mutant, failing) {
  const failures = [];
  if (mutant.direction !== "flag") {
    if (failing.length > 0) {
      failures.push(`${mutant.name}: an inert mutant must not change any asserted value`);
    }
    return failures;
  }
  if (failing.length === 0) {
    failures.push(`${mutant.name}: changes the declared sites and is caught by nothing`);
    return failures;
  }
  if (failing.slice().sort().join(",") !== mutant.catches.slice().sort().join(",")) {
    failures.push(
      `${mutant.name}: fails ${failing.join(",")} but declares ${mutant.catches.join(",")}`,
    );
  }
  return failures;
}

function mutantGateFailures(source, mutants) {
  const failures = [];
  for (const mutant of mutants) {
    const applied = applyMutant(source, mutant);
    failures.push(...mutantEditFailures(source, mutant, applied));
    if (applied.source === source) continue;
    const failing = failingAssertions(observe(buildSubject(applied.source)));
    failures.push(...mutantDirectionFailures(mutant, failing));
  }
  return failures;
}

// The census gate reads `anchored` from the assertion table and `direction` from the mutant
// table - the fields the tables declare. It returns the holes it found instead of exiting,
// so that the wiring itself can be proven non-vacuous.
function censusSiteHoles(report) {
  return report.uncovered.map((entry) => `published site with no anchor: ${entry}`);
}

function censusMutantHoles(assertions, mutants) {
  const holes = [];
  const anchoredKeys = new Set(
    assertions.filter((assertion) => assertion.anchored).map((assertion) => assertion.key),
  );
  for (const name of SINGLE_SITE_MUTANTS) {
    const mutant = mutants.find((entry) => entry.name === name);
    if (!mutant) {
      holes.push(`single-site mutant ${name} is missing from the iterated list`);
      continue;
    }
    const applied = applyMutant(SUBJECT_SOURCE, mutant);
    const failing = failingAssertions(observe(buildSubject(applied.source)));
    const anchoredCatchers = failing.filter((key) => anchoredKeys.has(key));
    if (anchoredCatchers.length === 0) {
      holes.push(
        `single-site mutant ${name} is caught only by ${failing.join(",") || "nothing"}, which are not input-anchored`,
      );
    }
  }
  return holes;
}

function censusHoles(observation, assertions, mutants) {
  const report = censusReport(observation);
  const holes = [...censusSiteHoles(report), ...censusMutantHoles(assertions, mutants)];
  return { holes, report };
}

function hole(message) {
  process.stderr.write(`CARRIER HOLE: ${message}\n`);
  process.exit(6);
}

function rangesOf(text, needle) {
  const ranges = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    ranges.push([index, index + needle.length]);
    index = text.indexOf(needle, index + 1);
  }
  return ranges;
}

function occurrencesOf(text, needle) {
  return rangesOf(text, needle).map(([start]) => start);
}

function censusReport(observation) {
  const outputs = {
    device: observation.deviceFlat,
    worker: observation.workerFlat,
    topology: observation.topologyFlat,
  };
  const sites = process.env.RELAY_CARRIER_INJECT_HOLE
    ? PUBLISHED_SITES.filter((entry) => entry.site !== "topology.collapse")
    : PUBLISHED_SITES;
  const uncovered = [];
  let total = 0;
  for (const [output, text] of Object.entries(outputs)) {
    for (const index of occurrencesOf(text, DEVICE.name)) {
      total += 1;
      const covered = sites.some((entry) => {
        if (entry.output !== output) return false;
        return rangesOf(text, entry.pattern).some(([start, end]) => index >= start && index < end);
      });
      if (!covered) {
        uncovered.push(`${output}@${index}: ${text.slice(Math.max(0, index - 40), index + 40)}`);
      }
    }
  }
  return { total, uncovered, sites };
}

// The corpus check: the carrier's own loader transform is applied to every tracked source
// file, and every result must still parse. A transform that corrupts a file is a probe
// defect, and a swallowed exception would shrink the denominator, so failures are counted
// with their file name and the processed count is asserted against the file count.
function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "*.mjs", "*.js"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output.split("\n").filter((line) => line.length > 0);
}

function parseFailures(files, transform) {
  const script = [
    'const vm = require("node:vm");',
    'const { readFileSync } = require("node:fs");',
    `const transform = ${transform.toString()};`,
    "const files = JSON.parse(process.env.RELAY_CARRIER_CORPUS);",
    "const broken = [];",
    "let processed = 0;",
    "for (const file of files) {",
    "  processed += 1;",
    "  try {",
    '    new vm.SourceTextModule(transform(readFileSync(file, "utf8")));',
    "  } catch (error) {",
    '    broken.push(file + ": " + String(error.message).split("\\n")[0]);',
    "  }",
    "}",
    "process.stdout.write(JSON.stringify({ processed, broken }));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--experimental-vm-modules", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELAY_CARRIER_CORPUS: JSON.stringify(files) },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(output);
}

function cloneSnapshot() {
  return structuredClone(SNAPSHOT);
}

const INERT_CONTROLS = [
  {
    name: "an extra device in the snapshot",
    build: () => {
      const snapshot = cloneSnapshot();
      snapshot.devices.push({
        id: "host:c",
        name: "gamma",
        init: 1699999999000,
        authority: "hub:1",
        receivedAt: 1699999999500,
        stale: false,
        free: 3,
      });
      snapshot.totals.devices = 3;
      snapshot.visible.devices = 3;
      return { source: SUBJECT_SOURCE, snapshot };
    },
  },
  {
    name: "a later snapshot time",
    build: () => {
      const snapshot = cloneSnapshot();
      snapshot.time += 5000;
      return { source: SUBJECT_SOURCE, snapshot };
    },
  },
  {
    name: "a different device init timestamp",
    build: () => {
      const snapshot = cloneSnapshot();
      snapshot.devices[0].init += 1000;
      return { source: SUBJECT_SOURCE, snapshot };
    },
  },
  {
    name: "a different agent init timestamp",
    build: () => {
      const snapshot = cloneSnapshot();
      snapshot.agents[0].init += 1000;
      return { source: SUBJECT_SOURCE, snapshot };
    },
  },
  {
    name: "a board without a received timestamp",
    build: () => {
      const snapshot = cloneSnapshot();
      snapshot.boards[0].receivedAt = null;
      return { source: SUBJECT_SOURCE, snapshot };
    },
  },
  {
    name: "a comment added to the subject source",
    build: () => ({
      source: SUBJECT_SOURCE.replace(
        "const MAX_VISIBLE_WORKERS = 24;",
        "const MAX_VISIBLE_WORKERS = 24;\n// inert control: a comment changes no published value.",
      ),
      snapshot: cloneSnapshot(),
    }),
  },
];

const baseline = observe(buildSubject(SUBJECT_SOURCE));

// Liveness switch: a mutant that changes a source site the carrier does not assert on is
// caught by nothing, and the gate must end the run with exit code 6.
const INJECTED_MUTANTS = process.env.RELAY_CARRIER_INJECT_UNCAUGHT
  ? [
      {
        name: "injectedUncaught",
        description: "a change to a site the carrier does not assert on",
        direction: "flag",
        edits: [
          {
            from: '    ["Report age", age(board.receivedAt, snapshot.time, !board.reported)],',
            to: '    ["Report age", "injected"],',
            count: 1,
          },
        ],
        catches: [],
      },
    ]
  : [];

// The gates run at load time, so a hole ends the run with exit code 6 whether the file is
// executed directly or by the test runner. The same gates run again inside the test
// callbacks, so a runner also reports them as ordinary test failures.
function loadTimeGateFailures() {
  return [
    ...mutantGateFailures(SUBJECT_SOURCE, [...MUTANTS, ...INJECTED_MUTANTS]),
    ...censusHoles(baseline, ASSERTIONS, MUTANTS).holes,
  ];
}

const LOAD_TIME_FAILURES = loadTimeGateFailures();
if (LOAD_TIME_FAILURES.length > 0) {
  hole(`carrier gate failures: ${LOAD_TIME_FAILURES.join(" | ")}`);
}

test("baseline: every anchored assertion passes on the unmodified subject", (t) => {
  t.diagnostic(`assertions in the iterated list: ${ASSERTIONS.length}`);
  for (const assertion of ASSERTIONS)
    t.diagnostic(`assertion ${assertion.key} -> ${assertion.site}`);
  assert.equal(
    ASSERTIONS.length,
    DECLARED_ASSERTION_COUNT,
    "the declared assertion count must match the iterated list",
  );
  const failures = failingAssertions(baseline);
  assert.deepEqual(failures, [], `assertions that fail on the baseline: ${failures.join(", ")}`);
});

test("non-vacuity: every named mutant fails exactly the assertions it declares", (t) => {
  t.diagnostic(`mutants in the iterated list: ${MUTANTS.length}`);
  for (const mutant of MUTANTS) t.diagnostic(`mutant ${mutant.name} (${mutant.direction})`);
  assert.equal(
    MUTANTS.length,
    DECLARED_MUTANT_COUNT,
    "the declared mutant count must match the iterated list",
  );
  const failures = loadTimeGateFailures();
  if (failures.length > 0) {
    hole(`mutant gate failures: ${failures.join(" | ")}`);
  }
});

test("free-field census: every published site is anchored and every single-site mutant is caught", (t) => {
  const { holes, report } = censusHoles(baseline, ASSERTIONS, MUTANTS);
  t.diagnostic(`published occurrences of "${DEVICE.name}": ${report.total}`);
  t.diagnostic(`declared sites: ${report.sites.map((entry) => entry.site).join(", ")}`);
  t.diagnostic(`single-site mutants: ${SINGLE_SITE_MUTANTS.join(", ")}`);
  if (holes.length > 0) hole(`census holes: ${holes.join(" | ")}`);
  // The denominator must match the enumerated set, and the population must be non-empty:
  // a boolean cannot tell "nothing was masked" from "nothing was examined".
  assert.equal(
    report.sites.length,
    PUBLISHED_SITES.length,
    "the enumerated site set must be the declared site set",
  );
  assert.equal(
    report.total,
    PUBLISHED_SITES.length,
    "every published occurrence must be covered by a declared site",
  );
  assert.ok(report.total > 0, "the census must examine at least one published occurrence");
  assert.equal(
    SINGLE_SITE_MUTANTS.length,
    PUBLISHED_SITES.length,
    "the single-site mutant population must equal the enumerated site set",
  );
  // Every declared site must carry at least one input-anchored assertion. The count and the
  // witness keys are reported, so a site that silently lost its anchors is visible.
  for (const site of PUBLISHED_SITES) {
    const bound = ASSERTIONS.filter(
      (assertion) => assertion.anchored && assertion.site === site.site,
    );
    assert.ok(bound.length > 0, `the declared site ${site.site} has no input-anchored assertion`);
    t.diagnostic(
      `site ${site.site}: ${bound.length} anchored assertion(s): ${bound.map((a) => a.key).join(", ")}`,
    );
  }
  const anchoredKeys = new Set(
    ASSERTIONS.filter((assertion) => assertion.anchored).map((assertion) => assertion.key),
  );
  for (const name of SINGLE_SITE_MUTANTS) {
    const mutant = MUTANTS.find((entry) => entry.name === name);
    const applied = applyMutant(SUBJECT_SOURCE, mutant);
    const failing = failingAssertions(observe(buildSubject(applied.source)));
    const anchoredCatchers = failing.filter((key) => anchoredKeys.has(key));
    t.diagnostic(`single-site mutant ${name} caught by ${anchoredCatchers.join(", ")}`);
  }
});

test("the gates are wired to the fields the tables declare", (t) => {
  // The census gate is driven by `anchored` on the assertion table: flipping that field on
  // the assertion that catches a single-site mutant must open a hole.
  const flippedAssertions = ASSERTIONS.map((assertion) =>
    assertion.key === "A_collapse_aria" ? { ...assertion, anchored: false } : assertion,
  );
  const opened = censusHoles(baseline, flippedAssertions, MUTANTS);
  assert.equal(
    opened.holes.length,
    1,
    "flipping `anchored` must open exactly one census hole, otherwise the census gate never reads it",
  );
  t.diagnostic(`census holes after flipping anchored: ${opened.holes.length}`);
  t.diagnostic(`witness: ${opened.holes[0]}`);

  // The mutant gate is driven by `direction` on the mutant table: flipping that field on a
  // mutant that IS caught must make the gate report a failure.
  const flippedMutants = MUTANTS.map((mutant) =>
    mutant.name === "collapseLabelOnly" ? { ...mutant, direction: "ignore" } : mutant,
  );
  const gateFailures = mutantGateFailures(SUBJECT_SOURCE, flippedMutants);
  assert.equal(
    gateFailures.length,
    1,
    "flipping `direction` must make the mutant gate fail exactly once, otherwise the gate never reads it",
  );
  t.diagnostic(`mutant gate failures after flipping direction: ${gateFailures.length}`);
  t.diagnostic(`witness: ${gateFailures[0]}`);

  // A closed label set alone cannot catch a valid-but-wrong label, so the independently
  // written expectation map must reject it.
  assert.throws(
    () => assertExpectationMap(flippedMutants),
    /the expectation map says/,
    "a valid-but-wrong direction must be rejected by the expectation map",
  );
});

test("necessity, measured against the named population", (t) => {
  // The population is NAMED before it is counted: the mutant population is the 29 mutants
  // of the mutant table. Against that population an assertion is necessary when it is the
  // only catcher of at least one mutant; against the oracle population (the assertion
  // table) necessity does not hold, and both facts are reported with counts and witnesses.
  const measured = new Map();
  for (const mutant of MUTANTS) {
    const applied = applyMutant(SUBJECT_SOURCE, mutant);
    measured.set(mutant.name, failingAssertions(observe(buildSubject(applied.source))));
  }
  assert.equal(measured.size, MUTANTS.length, "every mutant must be measured");
  const flagMutants = MUTANTS.filter((mutant) => mutant.direction === "flag");
  const ignoreMutants = MUTANTS.filter((mutant) => mutant.direction === "ignore");
  assert.equal(
    flagMutants.length + ignoreMutants.length,
    MUTANTS.length,
    "the flag and ignore populations must partition the mutant population",
  );
  const uncovered = flagMutants.filter((mutant) => measured.get(mutant.name).length === 0);
  assert.equal(
    uncovered.length,
    0,
    `flag mutants caught by nothing: ${uncovered.map((mutant) => mutant.name).join(", ")}`,
  );
  t.diagnostic(
    `population: the mutant population, ${MUTANTS.length} mutants (${flagMutants.length} flag, ${ignoreMutants.length} ignore); every flag mutant is caught by at least one assertion`,
  );
  let redundant = 0;
  for (const assertion of ASSERTIONS) {
    const catching = flagMutants.filter((mutant) =>
      measured.get(mutant.name).includes(assertion.key),
    );
    const exclusive = catching.filter((mutant) => measured.get(mutant.name).length === 1);
    if (exclusive.length === 0) redundant += 1;
    t.diagnostic(
      `assertion ${assertion.key}: catches ${catching.length} mutant(s) [${catching.map((m) => m.name).join(", ") || "none"}], exclusive ${exclusive.length} [${exclusive.map((m) => m.name).join(", ") || "none"}]`,
    );
  }
  t.diagnostic(
    `assertions with no exclusive mutant against the mutant population: ${redundant} of ${ASSERTIONS.length} (redundancy against the oracle population, not a failure)`,
  );
});

test("specificity: inert controls leave every assertion passing", (t) => {
  for (const control of INERT_CONTROLS) {
    const variant = control.build();
    const failing = failingAssertions(observe(buildSubject(variant.source), variant.snapshot));
    assert.deepEqual(
      failing,
      [],
      `inert control "${control.name}" must not change any asserted value`,
    );
    t.diagnostic(`inert control "${control.name}": ${ASSERTIONS.length} assertions still pass`);
  }
});

test("the declared unpinned fields are still published by the subject", () => {
  for (const entry of DECLARED_UNPINNED) {
    if (entry.output === "topology") {
      assert.ok(
        baseline.topologyFlat.includes(entry.label),
        `the unpinned field ${entry.label} is no longer published`,
      );
      continue;
    }
    assert.ok(
      baseline[entry.output].has(entry.label),
      `the unpinned field ${entry.label} is no longer published`,
    );
  }
});

test("a mislabelled mutant direction is a hard error, not a fallback to ignore", () => {
  // Every label other than the exact strings "flag" and "ignore" is rejected at load time.
  for (const label of ["FLAG", "must-flag", "diff", "same", "", "must-ignore", "ignore "]) {
    assert.throws(
      () => assertDirection(label),
      /must be "flag" or "ignore"/,
      `the direction ${JSON.stringify(label)} must be rejected`,
    );
  }
  // A VALID but wrong label is not a load-time error: it is caught by the run, which reads
  // the same field (see the gate-wiring test).
  assert.equal(assertDirection("flag"), undefined);
  assert.equal(assertDirection("ignore"), undefined);
});

test("the loader transform keeps every tracked file parseable", (t) => {
  const files = trackedFiles();
  assert.ok(files.length > 0, "the tracked corpus must not be empty");
  const directory = mkdtempSync(join(tmpdir(), "relay-carrier-"));
  const synthetic = join(directory, "synthetic-multiline-import.mjs");
  writeFileSync(
    synthetic,
    [
      "import {",
      "  one,",
      "  two,",
      '} from "./nowhere.mjs";',
      "export const value = one + two;",
      "",
    ].join("\n"),
  );
  try {
    const robust = parseFailures([...files, synthetic], stripImports);
    assert.equal(
      robust.processed,
      files.length + 1,
      "every tracked file must be processed, and an exception must never shrink the denominator",
    );
    assert.deepEqual(
      robust.broken,
      [],
      `the carrier's loader transform corrupts ${robust.broken.length} tracked files`,
    );
    const naive = parseFailures([...files, synthetic], stripImportsNaive);
    t.diagnostic(`tracked JS files: ${files.length}`);
    t.diagnostic(`files the naive per-line import strip corrupts: ${naive.broken.length}`);
    t.diagnostic(
      `the naive strip corrupts the synthetic multi-line import: ${naive.broken.some((entry) => entry.startsWith(synthetic))}`,
    );
    assert.ok(
      naive.broken.some((entry) => entry.startsWith(synthetic)),
      "the corpus check must be live: the naive strip has to fail on the synthetic multi-line import",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
