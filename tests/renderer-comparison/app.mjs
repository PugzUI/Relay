import { Application, Container, Graphics } from "./vendor/pixi.min.mjs";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const lime = "#c4ff00";
const world = { nodes: [], links: [], width: 1000, height: 700 };
const state = {
  zoom: 1,
  pan: [0, 0],
  pulses: [],
  selected: null,
  time: 0,
  paused: false,
  dirty: true,
  count: 0,
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  measure: null,
  lastReport: null,
};
$("motion").checked = state.reduced;

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
}

const svgWorld = el("g", {}, $("svg"));
const svgWires = el("g", {}, svgWorld);
const svgNodes = el("g", {}, svgWorld);
const svgSignals = el("g", {}, $("svg"));
const signalPool = { path: [], rect: [] };
let app, pixiWorld, pixiWires, pixiNodes, pixiSignals;
const views = ["svg", "pixi"];
const labelMaps = { svg: new Map(), pixi: new Map() };
const lastTransforms = {};
const gpu = { available: false, error: null };

function topology(clusters) {
  const cols = Math.ceil(Math.sqrt(clusters));
  world.nodes = [];
  world.links = [];
  world.width = cols * 1000;
  world.height = Math.ceil(clusters / cols) * 700;
  for (let i = 0; i < clusters; i++) {
    const ox = (i % cols) * 1000;
    const oy = Math.floor(i / cols) * 700;
    const defs = [
      ["device", 500, 75, "device"],
      ["inbox", 220, 225, "board"],
      ["bounties", 780, 225, "board"],
      ["relay", 500, 345, "relay"],
      ["worker-a", 180, 555, "agent"],
      ["worker-b", 500, 600, "agent"],
      ["worker-c", 820, 555, "agent"],
    ];
    for (const [name, x, y, kind] of defs) {
      world.nodes.push({
        id: `${i}:${name}`,
        name: clusters === 1 ? name : `${name} / ${i + 1}`,
        kind,
        x: x + ox,
        y: y + oy,
      });
    }
    const node = (name) => world.nodes.find((n) => n.id === `${i}:${name}`);
    for (const name of ["device", "inbox", "bounties", "worker-a", "worker-b", "worker-c"]) {
      const a = node("relay");
      const b = node(name);
      const points =
        b.x === a.x
          ? [
              [a.x, a.y],
              [b.x, b.y],
            ]
          : [
              [a.x, a.y],
              [a.x + (b.x - a.x) * 0.45, a.y],
              [a.x + (b.x - a.x) * 0.45, b.y],
              [b.x, b.y],
            ];
      world.links.push({ id: `${i}:${name}`, points });
    }
  }
}

function path(points) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
}

function segments(points) {
  return points.slice(1).map((p, i) => ({
    a: points[i],
    b: p,
    length: Math.hypot(p[0] - points[i][0], p[1] - points[i][1]),
  }));
}

function sample(points, t) {
  const ss = segments(points);
  const length = ss.reduce((a, s) => a + s.length, 0);
  let distance = Math.max(0, Math.min(1, t)) * length;
  for (const s of ss) {
    if (distance <= s.length) {
      const u = s.length ? distance / s.length : 0;
      return [s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u];
    }
    distance -= s.length;
  }
  return points.at(-1);
}

function transform(view) {
  const box = $(`${view}-view`);
  const scale =
    Math.min(box.clientWidth / world.width, box.clientHeight / world.height) * state.zoom * 0.91;
  return {
    scale,
    x: (box.clientWidth - world.width * scale) / 2 + state.pan[0],
    y: (box.clientHeight - world.height * scale) / 2 + state.pan[1],
    width: box.clientWidth,
    height: box.clientHeight,
  };
}

function project(p, tr) {
  return [p[0] * tr.scale + tr.x, p[1] * tr.scale + tr.y];
}

function glyph(n) {
  const { x, y, kind } = n;
  if (kind === "agent")
    return [
      [x, y - 16],
      [x + 16, y],
      [x, y + 16],
      [x - 16, y],
      [x, y - 16],
    ];
  if (kind === "board")
    return [
      [x - 19, y - 13],
      [x + 19, y - 13],
      [x + 19, y + 13],
      [x - 19, y + 13],
      [x - 19, y - 13],
    ];
  if (kind === "relay")
    return [
      [x - 19, y - 19],
      [x + 19, y - 19],
      [x + 19, y + 19],
      [x - 19, y + 19],
      [x - 19, y - 19],
    ];
  return [
    [x - 19, y - 13],
    [x + 19, y - 13],
    [x + 19, y + 13],
    [x - 19, y + 13],
    [x - 19, y - 13],
  ];
}

function line(g, points, color, alpha = 1) {
  g.moveTo(...points[0]);
  for (const p of points.slice(1)) g.lineTo(...p);
  g.stroke({ color, alpha, pixelLine: true });
}

function select(id) {
  state.selected = id;
  const n = world.nodes.find((node) => node.id === id);
  $("selection").textContent =
    `${n.name} · ${n.kind} · fixture node. Both maps share this selection.`;
  for (const view of views) {
    for (const [key, b] of labelMaps[view]) b.setAttribute("aria-pressed", String(key === id));
  }
  state.dirty = true;
}

function clearScene() {
  svgWires.replaceChildren();
  svgNodes.replaceChildren();
  svgSignals.replaceChildren();
  signalPool.path = [];
  signalPool.rect = [];
  if (gpu.available) {
    pixiWires.clear();
    pixiNodes.clear();
  }
}

function drawLink(l) {
  el(
    "path",
    {
      d: path(l.points),
      fill: "none",
      stroke: "#646464",
      "stroke-width": 1,
      "vector-effect": "non-scaling-stroke",
    },
    svgWires,
  );
  if (gpu.available) line(pixiWires, l.points, 0x646464);
}

function drawRelayMark(n) {
  el(
    "path",
    {
      d: `M${n.x - 7},${n.y}h14 M${n.x},${n.y - 7}v14`,
      stroke: lime,
      "vector-effect": "non-scaling-stroke",
    },
    svgNodes,
  );
  if (gpu.available) {
    line(
      pixiNodes,
      [
        [n.x - 7, n.y],
        [n.x + 7, n.y],
      ],
      0xc4ff00,
    );
    line(
      pixiNodes,
      [
        [n.x, n.y - 7],
        [n.x, n.y + 7],
      ],
      0xc4ff00,
    );
  }
}

function drawNode(n) {
  el(
    "path",
    {
      d: path(glyph(n)),
      fill: "#000",
      stroke: "#c2c2c2",
      "stroke-width": 1,
      "vector-effect": "non-scaling-stroke",
      "data-node": n.id,
    },
    svgNodes,
  );
  if (gpu.available) {
    pixiNodes.poly(glyph(n).flat()).fill(0x000000);
    line(pixiNodes, glyph(n), 0xc2c2c2);
  }
  if (n.kind === "relay") drawRelayMark(n);
}

function rebuildLabels(view) {
  const host = $(`${view}-labels`);
  host.replaceChildren();
  labelMaps[view].clear();
  for (const n of world.nodes) {
    const b = document.createElement("button");
    b.className = "node-label";
    b.textContent = n.name;
    const sub = document.createElement("span");
    sub.textContent = n.kind;
    b.append(sub);
    b.setAttribute("aria-label", `${view}: ${n.name}, ${n.kind}`);
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => select(n.id);
    host.append(b);
    labelMaps[view].set(n.id, b);
  }
}

function rebuild() {
  clearScene();
  for (const l of world.links) drawLink(l);
  for (const n of world.nodes) drawNode(n);
  for (const view of views) rebuildLabels(view);
  state.dirty = true;
}

function emit(kind, cluster = 0, quiet = false) {
  if (state.pulses.length >= 512) {
    $("status").textContent = "Simulation capacity reached (512 signals).";
    return;
  }
  const work = kind === "work";
  const from = `${cluster}:${work ? "bounties" : "worker-a"}`;
  const to = `${cluster}:${work ? "worker-c" : "inbox"}`;
  const source = world.links.find((l) => l.id === from);
  const target = world.links.find((l) => l.id === to);
  if (!source || !target) return;
  const points = [...source.points].reverse().concat(target.points.slice(1));
  state.pulses.push({
    id: ++state.count,
    kind,
    from,
    to,
    points,
    start: state.time,
    duration: 1600,
  });
  if (!quiet) {
    const label = `${String(state.count).padStart(3, "0")} · ${work ? "WORK CLAIMED" : "MESSAGE COMMITTED"} · ${from.split(":")[1]} → ${to.split(":")[1]}`;
    const li = document.createElement("li");
    li.textContent = label;
    $("ledger").prepend(li);
    while ($("ledger").children.length > 20) $("ledger").lastChild.remove();
    $("status").textContent = label;
  }
  state.dirty = true;
}

function signalElement(used, tag, attrs) {
  const i = used[tag]++;
  const n = signalPool[tag][i] ?? el(tag, {}, svgSignals);
  signalPool[tag][i] = n;
  n.removeAttribute("display");
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
}

function strokeSignal(used, isSvg, points, alpha, width = 1) {
  if (isSvg) {
    signalElement(used, "path", {
      d: path(points),
      fill: "none",
      stroke: lime,
      "stroke-width": width,
      opacity: alpha,
    });
    return;
  }
  pixiSignals.moveTo(...points[0]);
  for (const p of points.slice(1)) pixiSignals.lineTo(...p);
  pixiSignals.stroke({ color: 0xc4ff00, alpha, width });
}

function headSignal(used, isSvg, x, y, work, alpha = 1) {
  if (isSvg) {
    signalElement(used, "rect", {
      x: x - 3,
      y: y - 3,
      width: 6,
      height: 6,
      fill: work ? "#000" : lime,
      stroke: lime,
      opacity: alpha,
    });
    return;
  }
  pixiSignals
    .rect(x - 3, y - 3, 6, 6)
    .fill({ color: work ? 0x000000 : 0xc4ff00, alpha })
    .stroke({ color: 0xc4ff00, alpha, width: 1 });
}

function drawPulse(used, isSvg, p, tr) {
  const age = state.time - p.start;
  const u = Math.min(age / p.duration, 1);
  if (state.reduced) {
    strokeSignal(
      used,
      isSvg,
      p.points.map((q) => project(q, tr)),
      0.65,
    );
    const end = project(p.points.at(-1), tr);
    headSignal(used, isSvg, end[0], end[1], p.kind === "work");
    return;
  }
  if (u < 1) {
    const tail = [];
    for (let j = 7; j >= 0; j--) {
      tail.push(project(sample(p.points, Math.max(0, u - j * 0.008)), tr));
    }
    for (let j = 1; j < tail.length; j++) {
      strokeSignal(used, isSvg, [tail[j - 1], tail[j]], (j / tail.length) * 0.7);
    }
    const head = project(sample(p.points, u), tr);
    headSignal(used, isSvg, head[0], head[1], p.kind === "work");
    return;
  }
  const end = project(p.points.at(-1), tr);
  const a = 1 - (age - p.duration) / 350;
  strokeSignal(
    used,
    isSvg,
    [
      [end[0] - 9, end[1]],
      [end[0] + 9, end[1]],
    ],
    a,
  );
  strokeSignal(
    used,
    isSvg,
    [
      [end[0], end[1] - 9],
      [end[0], end[1] + 9],
    ],
    a,
  );
}

function drawSelection(used, isSvg, tr) {
  const n = world.nodes.find((node) => node.id === state.selected);
  if (!n) return;
  const [x, y] = project([n.x, n.y], tr);
  strokeSignal(
    used,
    isSvg,
    [
      [x - 22, y - 22],
      [x + 22, y - 22],
      [x + 22, y + 22],
      [x - 22, y + 22],
      [x - 22, y - 22],
    ],
    1,
  );
}

function hideUnusedSignals(used) {
  for (const tag of ["path", "rect"]) {
    for (let i = used[tag]; i < signalPool[tag].length; i++) {
      signalPool[tag][i].setAttribute("display", "none");
    }
  }
}

function drawSignals(view, tr) {
  const isSvg = view === "svg";
  if (!isSvg) {
    if (!gpu.available) return;
    pixiSignals.clear();
  }
  const used = { path: 0, rect: 0 };
  for (const p of state.pulses) drawPulse(used, isSvg, p, tr);
  if (state.selected) drawSelection(used, isSvg, tr);
  if (isSvg) hideUnusedSignals(used);
}

function render(view) {
  const tr = transform(view);
  const before = lastTransforms[view];
  lastTransforms[view] = tr;
  if (view === "svg") {
    svgWorld.setAttribute("transform", `translate(${tr.x} ${tr.y}) scale(${tr.scale})`);
  } else if (gpu.available) {
    pixiWorld.position.set(tr.x, tr.y);
    pixiWorld.scale.set(tr.scale);
    if (
      app.renderer.width !== Math.round(tr.width * app.renderer.resolution) ||
      app.renderer.height !== Math.round(tr.height * app.renderer.resolution)
    ) {
      app.renderer.resize(tr.width, tr.height);
    }
  }
  const moved = !before || tr.scale !== before.scale || tr.x !== before.x || tr.y !== before.y;
  if (state.dirty || moved) {
    for (const n of world.nodes) {
      const b = labelMaps[view].get(n.id);
      const [x, y] = project([n.x, n.y], tr);
      b.style.left = `${x}px`;
      b.style.top = `${y + 19 * tr.scale}px`;
      b.hidden = tr.scale < 0.16;
    }
  }
  drawSignals(view, tr);
  if (view === "pixi" && gpu.available) app.renderer.render(app.stage);
}

const percentile = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

let last = performance.now(),
  lastStats = 0,
  streamAt = 0,
  frameIndex = 0;

function advanceTime(now) {
  const delta = Math.min(now - last, 100);
  last = now;
  if (!state.paused) state.time += delta;
}

function streamSignals() {
  if (!$("stream").checked || state.paused || state.time - streamAt <= 450) return;
  emit(state.count % 2 ? "work" : "message", state.count % Number($("size").value));
  streamAt = state.time;
}

function measurementLoad(now) {
  if (!state.measure) return;
  if (now - state.measure.started >= 5000) return;
  if (state.paused) return;
  if (state.pulses.length >= 96) return;
  for (let i = 0; i < 6; i++) {
    emit(i % 2 ? "work" : "message", (state.count + i) % Number($("size").value), true);
  }
}

function renderViews() {
  const order = frameIndex++ % 2 ? views : [...views].reverse();
  for (const view of order) {
    const t = performance.now();
    render(view);
    if (state.measure) state.measure[view].push(performance.now() - t);
  }
  state.dirty = false;
}

function reportMeasurement(now) {
  if (!state.measure) return;
  if (now - state.measure.started < 5000) return;
  const m = state.measure;
  state.lastReport = {
    nodes: world.nodes.length,
    svg: { median: percentile(m.svg, 0.5), p95: percentile(m.svg, 0.95), samples: m.svg.length },
    pixi: {
      median: percentile(m.pixi, 0.5),
      p95: percentile(m.pixi, 0.95),
      samples: m.pixi.length,
    },
    backend: $("backend").textContent,
    dpr: devicePixelRatio,
  };
  $("measurement").textContent =
    `CPU update/submission · ${world.nodes.length} nodes · SVG median ${state.lastReport.svg.median.toFixed(2)} ms / p95 ${state.lastReport.svg.p95.toFixed(2)} ms · Pixi median ${state.lastReport.pixi.median.toFixed(2)} ms / p95 ${state.lastReport.pixi.p95.toFixed(2)} ms. Includes shared DOM labels. Not GPU time or independent FPS.`;
  state.measure = null;
  $("measure").disabled = false;
}

function updateStats(now) {
  if (now - lastStats <= 250) return;
  for (const view of views) {
    $(`${view}-stats`).textContent =
      `${world.nodes.length} nodes / ${world.links.length} wires / ${state.pulses.length} signals · zoom ${state.zoom.toFixed(1)}×${view === "pixi" && !gpu.available ? " · GPU unavailable" : ""}`;
  }
  lastStats = now;
}

function frame(now) {
  advanceTime(now);
  streamSignals();
  measurementLoad(now);
  const active = state.pulses.length > 0;
  state.pulses = state.pulses.filter(
    (p) => state.time - p.start < (state.reduced ? 600 : p.duration + 350),
  );
  if (state.dirty || (active && !state.paused) || state.measure) renderViews();
  reportMeasurement(now);
  updateStats(now);
  requestAnimationFrame(frame);
}

function cancelMeasurement(reason) {
  if (!state.measure) return;
  state.measure = null;
  state.lastReport = null;
  $("measure").disabled = false;
  $("measurement").textContent =
    `Measurement cancelled: ${reason}. Run it again with unchanged settings.`;
}

for (const event of ["click", "input", "change"]) {
  document
    .querySelector("nav")
    .addEventListener(event, () => cancelMeasurement("simulation controls changed"));
}

$("message").onclick = () => emit("message");
$("claim").onclick = () => emit("work");
$("burst").onclick = () => {
  for (let i = 0; i < 24; i++) emit(i % 2 ? "work" : "message", i % Number($("size").value));
};
$("pause").onclick = () => {
  state.paused = !state.paused;
  $("pause").textContent = state.paused ? "Resume" : "Pause";
  $("pause").setAttribute("aria-pressed", String(state.paused));
  state.dirty = true;
};
$("motion").onchange = () => {
  state.reduced = $("motion").checked;
  state.dirty = true;
};
$("zoom").oninput = () => {
  state.zoom = Number($("zoom").value);
  state.dirty = true;
};
$("reset").onclick = () => {
  state.zoom = 1;
  state.pan = [0, 0];
  $("zoom").value = "1";
  state.pulses = [];
  state.dirty = true;
};
$("size").onchange = () => {
  state.pulses = [];
  state.selected = null;
  state.pan = [0, 0];
  state.zoom = 1;
  $("zoom").value = "1";
  topology(Number($("size").value));
  rebuild();
  $("selection").textContent = "Select a node in either map.";
};
$("measure").onclick = () => {
  if (!gpu.available) {
    $("measurement").textContent =
      "Comparison unavailable: Pixi did not initialize. No timing results will be recorded.";
    return;
  }
  if (state.paused) $("pause").click();
  state.lastReport = null;
  state.measure = { started: performance.now(), svg: [], pixi: [] };
  $("measure").disabled = true;
  $("measurement").textContent =
    "Measuring both renderers under the same simulated load for 5 seconds…";
};

for (const view of views) {
  const host = $(`${view}-view`);
  let drag = null;
  host.onpointerdown = (e) => {
    cancelMeasurement("map interaction");
    if (e.target.closest("button")) return;
    drag = [e.clientX, e.clientY, ...state.pan];
    host.setPointerCapture(e.pointerId);
  };
  host.onpointermove = (e) => {
    if (!drag) return;
    state.pan = [drag[2] + e.clientX - drag[0], drag[3] + e.clientY - drag[1]];
    state.dirty = true;
  };
  host.onpointerup = host.onpointercancel = () => {
    drag = null;
  };
  new ResizeObserver(() => {
    cancelMeasurement("viewport resized");
    state.dirty = true;
  }).observe(host);
}

document.addEventListener("visibilitychange", () => {
  last = performance.now();
  if (document.hidden) cancelMeasurement("page became hidden");
});
window.addEventListener(
  "pagehide",
  () => {
    if (app) app.destroy(true, { children: true });
  },
  { once: true },
);

topology(1);
rebuild();
requestAnimationFrame(frame);

try {
  app = new Application();
  await app.init({
    width: $("pixi-view").clientWidth,
    height: $("pixi-view").clientHeight,
    background: 0x000000,
    antialias: true,
    resolution: devicePixelRatio,
    autoDensity: true,
    autoStart: false,
    preference: "webgl",
  });
  app.canvas.setAttribute("aria-hidden", "true");
  $("pixi-view").prepend(app.canvas);
  pixiWorld = new Container();
  pixiWires = new Graphics();
  pixiNodes = new Graphics();
  pixiSignals = new Graphics();
  pixiWorld.addChild(pixiWires, pixiNodes);
  app.stage.addChild(pixiWorld, pixiSignals);
  gpu.available = true;
  $("backend").textContent = "WebGL / pixelLine";
  rebuild();
} catch (error) {
  gpu.error = error.message;
  $("backend").textContent = "GPU unavailable";
  $("pixi-stats").textContent = `Pixi initialization failed: ${error.message}`;
  $("status").textContent = "SVG is available. Pixi could not initialize a GPU renderer.";
  console.error(error);
}

window.rendererStudy = { state, world, gpu, emit, sample, transform };
