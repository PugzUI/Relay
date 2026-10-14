# Overview UI decision

The owner reopened UI framework selection for the functional overview. Storage,
protocol, authentication and native-delivery qualification are unchanged.

## Selected stack

**Lit + semantic light DOM + native SVG + external CSS.** Lit's components are
standard Web Components, and it supports rendering into light DOM through
`createRenderRoot()`.[1][2] Relay uses this option to keep one PugzUI stylesheet,
inspectable native controls and the existing strict CSP rather than generating
inline styles or adding a shadow-root theme boundary.

`ui/console.mjs` owns the overview, topology and inspector views.
`ui/main.mjs` owns requests, validated snapshots, selection, board pages and
committed-event pulses. Component-local filtering/collapse state is a view
preference, not a queue or execution authority. Keyed nodes retain identity and
focus across snapshot refreshes. No framework router or store is introduced.

The esbuild development step emits `ui/assets/console.mjs` and third-party
license notices. The bundle is checked in and packaged: installed Relay needs
neither a CDN nor an npm resolver in the browser. Node runtime dependencies
remain empty. `npm run build:ui` rebuilds it; `npm run check` refuses stale
compiled assets. Lit requires modern browser APIs and bare-import resolution;
bundling resolves those imports locally.[3]

## Framework comparison

These are project-fit judgments, not performance benchmarks or claims that a
framework determines visual quality.

| Candidate | Relevant design | Decision for Relay |
|---|---|---|
| Lit | Standards-based Web Components with declarative JavaScript templates.[1] | Selected. Incremental view migration without replacing transport or state. |
| Svelte 5 | Compiler-based components and fine-grained runes.[4] | Strong alternative for a broader application rewrite; not necessary for this view-only increment. |
| Solid | JSX and fine-grained DOM reactivity.[5] | Capable, but its transform and reactive application model buy little here. |
| Datastar | Backend-driven element/signal SSE updates; default expressions use `Function()` and require `unsafe-eval`.[6][7] | Rejected for this increment. Relay already has a JSON snapshot/audit-hint protocol, and its CSP should not be weakened. Datastar's separate CSP mode does not change that architectural mismatch. |
| Qwik | Resumability centered on serializable application state and server rendering.[8] | Solves a different startup/deployment problem from this authenticated operational console. |

## Renderer is a separate choice

- **Native SVG with HTML buttons:** selected. Stable device/worker branches,
  orthogonal live links, selectable labels, native keyboard activation and no
  canvas accessibility replacement. Membership branches are structural; live
  SVG links come only from snapshot relationships and accepted committed events.
- **Cytoscape.js:** credible graph-engine alternative with graph analysis and
  layout machinery.[9] Consider it only for a demonstrated graph interaction
  requirement; it is not needed for the current read-only hierarchy.
- **Sigma + Graphology:** WebGL visualization aimed at large graphs, with a
  separate graph model.[10] No measured Relay requirement justifies it here.
- **ELK:** a layout engine, not an interface or renderer. Layered/orthogonal
  routing is a future option for irregular cross-hierarchy links.[11]
- **D3:** data joins and visualization primitives; not a dashboard framework.[12]
  Keyed Lit templates cover the existing update need without another library.
- **xterm.js:** a terminal frontend, not a topology framework.[13] Terminal
  appearance does not require a PTY or interpretation of terminal escape codes.
- **AntV X6:** SVG/HTML diagram tooling.[14] Its editor/plugin surface would be
  unnecessary for this read-only page.

No hard node-count cutoff or comparative performance benchmark was established.
Revisit layout engines after measuring actual density/routing problems; do not
replace readable labels with a force simulation or shrink-to-fit network cloud.

## Interaction and presentation

Black/neutral surfaces, light text, lime focus and committed activity, zero
radius. The overview rail contains only scoped snapshot counts, with visible
subsets explicitly labeled. Missing observations remain unknown; cached state
is labeled and never promoted to fresh execution authority. The topology has
filtering, per-device collapse, Expand all, Refresh, and a selected-node
inspector. Inbox and Bounties retain separate permissions and pagination.

Use Tab/native Enter/Space for controls, arrows/Home/End within topology,
left/right for collapse/expand, `/` to focus the filter, and Escape to clear it.
Filtering reveals matching workers without forgetting collapsed branches.
The narrow layout stacks lanes and inspector; graph and history overflow stay
local. Reduced-motion users get a static committed-event highlight. Keyboard
focus and reduced motion require rendered verification, not framework claims.[15][16]

## Evidence boundary

The isolated browser probe under `tests/fixtures/ui/overview-qa.mjs` uses a real
Relay store, broker, credentials, committed posts and claims in an owned
Chromium profile. It covers selection/focus, filtering/collapse, scoped body
refusals, inert payloads, broker restart and authority replacement, revocation,
empty state, disconnect, responsive geometry and CSP/runtime errors. Its
synthetic participants qualify UI behavior only, not native agent delivery.
Screenshots stay in private verification output, not a public product gallery.
Only the exercised Chromium/Linux environment is qualified; other browsers,
assistive technologies and dense production topologies remain unqualified.

## Sources

[1] https://lit.dev/

[2] https://lit.dev/docs/components/shadow-dom

[3] https://lit.dev/docs/tools/requirements

[4] https://svelte.dev/blog/runes

[5] https://docs.solidjs.com/concepts/understanding-jsx

[6] https://data-star.dev/guide/getting_started

[7] https://data-star.dev/reference/security

[8] https://qwik.dev/docs/concepts/resumable

[9] https://js.cytoscape.org

[10] https://www.sigmajs.org/docs

[11] https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html

[12] https://d3js.org/d3-selection/joining

[13] https://github.com/xtermjs/xterm.js

[14] https://x6.antv.antgroup.com/en/tutorial/getting-started

[15] https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible

[16] https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
