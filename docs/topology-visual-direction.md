# Relay topology: visual direction and project scan

Research date: 2026-10-18. GitHub discovery included repositories created since
2026-10-11 and pushed since 2026-10-12, plus established libraries updated during
the same period. A recent creation date is not evidence of quality or readiness.

## Decision

Build an operational **top-down circuit map** in the center of a persistent
workspace. Surround it with independently collapsible, resizable **left, right,
and bottom drawers**. Keep Relay's snapshots, committed event feed, selection,
permission boundaries, and single state controller authoritative. Render links
only when there is a real relationship, and animate them only for eligible
committed events.

**Framework selection after the 2026-10-18 Executor search:** keep **Lit +
native SVG + CSS Grid** as the production stack, with [ELK.js](https://github.com/kieler/elkjs)
as an *optional layout-only* dependency after a measured layout test. Do not
introduce a second full graph or docking framework to solve fixed edge drawers.
The actual missing capabilities are a tiered viewport, clustering, reliable
geometry refresh and independent drawer state. None requires a new UI runtime.

The existing `tests/workspace-prototype/` already proves X6 + Dockview + xterm
against an isolated real Relay store, including layout persistence, committed
work claims, and console tabs. The `tests/renderer-comparison/` fixture compares
native SVG and Pixi for graph rendering. Both are development fixtures; neither
is a production UI migration or evidence of native agent attachment.

The current production `ui/index.html` has a vertical page with a device/worker
list, board lane, fixed inspector, and separate Inbox/Bounties section. CSS
positions lanes in two columns rather than placing the topology at the center
of an adaptable workspace. `ui/console.mjs` already connects real link and
pulse endpoints using native SVG; the snapshot and selection contracts can be
retained through a visual redesign.

## Evaluated tools

| Project | Evidence and licensing | Use in Relay |
| --- | --- | --- |
| [AntV X6](https://github.com/antvis/X6) | MIT, maintained; SVG/HTML graph with routing; already in isolated prototype | Useful comparison for composed nodes, orthogonal ports, fit/pan and scale. Production adoption needs a CSP review. |
| [Dockview](https://github.com/dockview/dockview) | Vanilla TypeScript integration, free MIT package; enterprise extension proprietary; v8.6.0 released Oct 16 | First choice *if* users need rearrangeable docking, floating tabs and saved layouts. Already in isolated prototype at 8.5.1. |
| [Cybercore CSS](https://github.com/sebyx07/cybercore-css) | MIT, pure CSS, neon borders and circuit/terminal motifs | Visual reference and selective technique source, not a wholesale design-system replacement. |
| [Cybercore Charts](https://github.com/sebyx07/cybercore-charts) | MIT, compact standalone SVG charts | Optional future statistics drawer. No chart required to solve topology. |
| [AntV G6](https://github.com/antvis/G6) | MIT, updated 2026-10-16; broader graph layouts | Consider only if native SVG/X6 struggles with actual graph size. |
| [Sigma.js](https://github.com/jacomyal/sigma.js) | MIT; WebGL graph, v4.0.3 on Oct 15 | New release this week, but GPU/Graphology setup exceeds requirements for an accessible tiered topology. |
| [netviz](https://github.com/ethp2p/netviz) | Apache-2.0; WebGL graph, time scrub, events; last pushed 2026-05-15 | Useful reference for event playback, excessive scope and rendering overhead for current requirements. |
| [NetOps Visual](https://github.com/craigderington/netops) | MIT; network monitoring with cyberpunk theme; last pushed 2026-01-18 | Visual reference for the palette and slide-out activity console, not a runtime dependency. |

### Fresh projects discovered in the past week

These were checked against GitHub repository metadata on 2026-10-18:

| Project | Created | Finding |
| --- | --- | --- |
| [Klaudio Panels](https://github.com/gianmarcozap/klaudio-panels) | Oct 16 | MIT; useful project sidebar, center terminal, bottom shell and inspector composition. Tauri/Solid, not a browser graph engine. |
| [Hive Station](https://github.com/Eugdou/hive-station) | Oct 16 | Edge-snapped, hover-expand/collapse interaction; Windows WPF and no license reported. Interaction inspiration only. |
| [Mist](https://github.com/wiktor-jozwiak/mist) | Oct 16 | Hyprland shell with edge surfaces; GPL-3.0, Rust desktop code; inspiration for inactive rails and responsive panels, not reusable web components. |
| [Hudkit](https://github.com/jamesrisberg/hudkit) | Oct 14 | MIT Swift HUD panel contracts; helpful modular-panel concept but not relevant web code. |
| [frontier-viz](https://github.com/DimensionLab/frontier-viz) | Oct 14 | Apache-2.0; early Rust/wgpu topology renderer; no mature drawer UI. |
| [Agent God's Eye](https://github.com/1nc0gn30/agent-gods-eye) | Oct 11 | Product description suggests agent DAG, but README is a Shodan globe with paid Pro upsells. Exclude. |

No new repo in that one-week sample offered a better integrated, license-clear,
visually finished browser topology workspace than the maintained X6 and Dockview
combination already under test. Most attractive references are visual treatments
or desktop interaction concepts, rather than turnkey Relay replacements.

Dockview's free [edge groups](https://dockview.dev/docs/core/groups/edgeGroups/)
can pin panels left, right and bottom, remember expanded size, and collapse to
a visible header tab. **Automatic hide/peek and automatic docking into edge
groups are Enterprise features**; Relay can deliver intentional manual collapse
using the MIT version without a paid dependency. Use [Dockview's licensing
matrix](https://dockview.dev/docs/overview/licence/) when selecting APIs.

## Concrete visual composition

```text
┌───────────────────┬────────────────────────────────┬───────────────────────┐
│ LEFT EDGE DRAWER  │ TOP BAR: Relay / scope / tools │ RIGHT EDGE DRAWER     │
│ Devices           ├────────────────────────────────┤ Selected node          │
│ Workers           │                                │ Authority / age        │
│ Saved filters     │     TOP-DOWN NETWORK MAP       │ State / capacity       │
│                   │                                │ Node actions           │
│ [collapse]        │  DEVICE → WORKER → BOARD       │ [collapse]            │
│                   │   right-angle signal paths     │                       │
├───────────────────┴────────────────────────────────┴───────────────────────┤
│ BOTTOM DRAWER:  Inbox | Bounties | Commit journal | Available console tabs  │
│ [collapse] [resize]                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

The topology is the visual priority, with an uninterrupted center canvas.
Devices, workers and boards form distinct levels according to real relationships
in `snapshot.links`, with stable ordering and grouping by device. This is a
top-down *hierarchy*, not a force-simulation cloud. Pan/zoom/fit should preserve
selection and not interfere with text input. Collapsing branches summarizes a
group rather than hiding a selected record without a way back.
The historical wide capture with 513 workers currently becomes a long list;
render clustered devices and counts by default and expand specific branches or
filter matches to inspect details. Do not emit links between unrelated tiers.

The left edge is a compact device/worker explorer. Right opens a detailed
inspector for the selected record. Bottom exposes the actual Inbox, Bounties
and committed journal views; a console tab only appears for a genuinely
attachable session. Each panel has a visible toggle and resizer, a collapsed
edge tab, keyboard access and a local scroll region. The graph reflows when a
drawer opens or closes. At narrow widths, use one active edge panel as an
overlay; center graph and controls remain usable.

### Neon circuits, restrained

- Black (`#000`) and graphite surfaces; 1px separators; square corners.
- Existing lime (`#c4ff00`) remains the primary active/selection signal.
- Muted grey thin paths at rest; precise orthogonal elbows, small junction dots,
  and one stronger lit trace **only on a committed event**. Differentiate
  message/work types by pattern and label, never hue alone.
- Allow one subtle glow layer on selected/live circuit paths; avoid glowing body
  copy, heavy bloom, breathing idle lights, fake packets or decorative charts.
- Device nodes are compact labeled enclosures; worker branches are narrower
  terminal-like modules; board nodes use distinct square connection ports.
- An optional faint fixed grid may aid orientation. It should disappear at
  small zoom levels and never reduce contrast. Respect reduced motion.
- Keep empty, stale, disconnected, cached and denied states explicit. No
  simulated activity outside clearly labeled development fixtures.

This is a deliberate proposed revision to the current `DESIGN.md` prohibition
on all glow and decorative motion, confined to selected/committed links.
The requested visual direction authorizes exploring this adjustment; product
theme tokens should remain singular in `ui/style.css` when implemented.

## Implementation path

1. Add a viewport-filling CSS Grid workspace with left, right and bottom
   collapsible/resizable drawers. Keep each control keyboard-accessible with
   persistent visible handles and explicit `aria-expanded`/focus restoration.
2. Re-layout the native SVG topology into top-down tiers, clustered by device
   and board with deterministic node positions. For a large snapshot (a
   retained test screenshot contains 513 workers), initially expose clusters
   and counts, then reveal workers via branch expansion and filter. Display
   only semantic links present in `snapshot.links`.
3. Keep the existing isolated X6 + Dockview prototype as a comparison for
   richer free-form docks and node editing. The prototype relies on inline
   positioning incompatible with the production `style-src 'self'` policy
   as written; preserve the security boundary unless separately reviewed.
4. Maintain
   `ui/state.mjs`, authorization, journal consumption and committed-event
   semantics intact. Make layout controls local view preferences and keep
   selections on the existing controller. Changing drawer dimensions, nested
   wrapping and branch expansion should invalidate SVG routes; observe the
   actual topology surface and coalesce measurements into one animation frame
   so paths follow visible nodes without repeated synchronous layout work.
5. Only if layouts become materially more complex, prototype ELK.js layered
   layout in a Web Worker against real 50/250/500-node fixtures with grouping,
   stable positions, edge routing and update latency. ELK is **EPL-2.0**
   licensed, not an MIT-only dependency, and does not render nodes or drawers.
6. Verify 320/360/760/1440px, keyboard/focus, 200% text, empty/cached/denied
   modes, motion-reduction, event expiry, and that closing/reopening panels
   never remounts the authority or duplicates feed subscriptions.

## Executor framework comparison (2026-10-18)

Three independent searches through Executor's **Firecrawl** and **Tavily**
surfaces, plus direct GitHub repository searches, release metadata and LICENSE
files through Executor's `github_com` integration, expanded the earlier scan.
The results below distinguish a framework's features from its demo styling;
no project scored as a fully integrated, ready-to-theme Relay workspace.

| Candidate | Verified evidence | Decision for Relay |
| --- | --- | --- |
| **Lit + SVG + CSS Grid** | Existing production stack; exact UI state, keyboard targets and CSP already in place | **Select.** Keeps real data/authorization and gives complete control of square black panels, orthogonal neon paths and state-driven effects. |
| [LogicFlow](https://github.com/didi/LogicFlow) | Apache-2.0; core `2.1.11` release Jan 23; current code active in Oct; vanilla TS, custom SVG/HTML nodes and polyline edges | Best additional full graph editor to try if native routing proves insufficient. Editing runtime and independent state would need stripping/bridging. |
| [Sprotty](https://github.com/eclipse-sprotty/sprotty) + [ELK.js](https://github.com/kieler/elkjs) | EPL-2.0 licenses; CSS-styled SVG, diagram architecture and directed layout; Sprotty's latest published release Dec 2024 | Strong read-only diagram architecture but substantially more framework/configuration than required, plus additional accessibility work. |
| [maxGraph](https://github.com/maxGraph/maxGraph) | Apache-2.0; `0.25.0` released Oct 6; advanced graph routing/diagram editing | Powerful and maintained; more editor functionality than an operations dashboard requires. |
| [FlowGram](https://github.com/bytedance/flowgram.ai) | MIT; `1.0.16` released Oct 13; composable canvas with React, Inversify, Styled Components and form/workflow infrastructure | Best *visual workflow-editor* reference this month, but React and workflow-building runtime violate Relay's existing product boundary. |
| [React Flow / XYFlow](https://github.com/xyflow/xyflow) | MIT; active in Oct; custom React components, rich interactions | Excellent greenfield solution. Requires a React migration Relay explicitly excludes. |
| [LiteGraph.js](https://github.com/jagenjo/litegraph.js) | MIT-style permissive license; JavaScript canvas node editor; repository active in Oct but latest published release Mar 2024 | Visually closest to circuitry by default, but canvas-first interaction sacrifices existing semantic HTML buttons. |
| [Dockview](https://github.com/dockview/dockview) | MIT free core; `8.6.0` released Oct 16; manually controlled edge groups and split/tabs; tested at `8.5.1` in Relay | Best future upgrade **only if** independently draggable/rearrangeable panels are required. Manual collapsible fixed drawers are simpler as CSS Grid. Auto-hide features have enterprise boundaries. |
| [LikeC4](https://likec4.dev/) | Interactive software architecture explorer with ELK-like hierarchical presentation; documented React embedding | Excellent visual/drill-down inspiration, not a drop-in Lit operations graph. |
| [DeepDiagram](https://github.com/LingyiChen-AI/DeepDiagram) | AI diagram generation tool, active Oct 17 | Creates diagrams from prompts; not a real-time runtime topology renderer. |

Avoid inferring performance from GitHub stars, recent commits or marketing
claims. No apples-to-apples benchmark between these candidates was performed.
The existing SVG/Pixi isolated fixture measured drawing/submission at 7, 63
and 252 nodes but explicitly did not measure real 500-node Relay graphs; its
reported CPU submission time is not full browser frame time. Benchmark
production shapes and interactions before replacing the renderer.

## Visual references

These are *inspiration only*, with no assumption that screenshots or assets are
licensed for reuse:

- [Network topology mapper, Synergy Codes](https://dribbble.com/shots/26605027-Network-topology-mapper): segmented orthogonal paths, colored circuits, compact node modules and a right property inspector.
- [Network graph concept, Netpin](https://netpin.io/): restrained luminous nodes over a dark grid with a floating inspector.
- [Cyberbrake network explorer redesign](https://medium.com/@vincent.gcaetano/transformed-cyberbrakes-network-analysis-explorer-into-an-intuitive-visual-workspace-by-removing-47a37d5a8e74): center network selection, right diagnostics, and sparse green/red state cues.
- [Dockview live demo](https://dockview.dev/): actual panel management, keyboard/resize/tab behavior.
- [Cybercore CSS live demo](https://sebyx07.github.io/cybercore-css/): motifs, typography and neon detail experiments.
