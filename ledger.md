# Critique ledger

## Round 0: baseline review

**Evidence:** existing Relay overview, `docs/topology-visual-direction.md`, and the pre-change fixture capture.

**Findings**

1. The product was operational and readable, but the main topology read as a conventional left-to-right list.
2. The visual hierarchy did not distinguish the source tier from the record tier quickly enough.
3. Large worker branches could create an unnecessarily tall or noisy surface.
4. Typography and materials already belonged to Relay, so a broad restyle would create more risk than value.

**Decision:** preserve architecture and state semantics; change topology composition, add a role edge vocabulary, cluster large branches, and keep motion limited to real committed events.

## Round 1: implementation review

**Evidence:** `docs/frames/01-initial-topology.png`, `docs/frames/02-filtered-transformation.png`, `docs/frames/03-mobile-composition.png`, and browser inspection at `http://127.0.0.1:4271/`.

**Changes**

- Topology moved from a left-to-right split to upper source tier / lower board tier.
- The topology heading gained a lime left rule to establish a clear entry point.
- Device, worker, and board nodes gained role-specific edge accents.
- Worker and board groups use content-driven grids that recompose on narrow screens.
- Worker branches over the visible threshold expose a real `N more workers · expand` control.
- Mono typography moved away from JetBrains Mono to the local IosevkaTerm/CommitMono stack with IBM Plex fallbacks.
- No new idle motion, gradients, blur, glow, shadow, or third-party rendering runtime was introduced.

**Verification:** 245 repository tests passed; `npm run check` passed; the overview fixture reported 18 passing checks, zero runtime exceptions, and zero CSP violations.

## Round 2: final self-review

**Evidence:** all captures in `docs/captures/` and the code-rendered frames in `docs/frames/`.

**Result**

- The initial desktop composition has a clear focal heading and readable two-tier topology.
- Filtered empty state preserves orientation and explains the result.
- Narrow composition stacks the field without clipping or hiding the primary controls.
- Disconnected, denied, cached, and empty states are explicit and visually distinct.
- Text at 200% remains readable in the captured narrow state.

**Historical note:** this round was explicitly non-independent because the first critic worker family could not be collected. It is retained as a record of the self-review, not as the final approval.

## Round 3: independent final review and correction pass

**Evidence:** fresh independent inspection of the rendered frames, the live fixture, and the responsive capture runner on 2026-10-18.

**Findings**

1. A retained inspector selection needed an explicit `filtered out` cue when a query produced no matching topology nodes.
2. The narrow filter control was visually cramped; a full-row control makes its placeholder and action affordance readable at 390px.
3. Disconnected state needed the red failure marker defined by the style bible.
4. The original narrow frame did not show the lower board/inspector lane.

**Corrections**

- The inspector now receives the active query and labels a retained selection `Worker · filtered out` when the result set hides it.
- Narrow filters occupy a full row while action buttons retain their 96px contract.
- Disconnected connection markers use the danger role color.
- Added `docs/frames/04-mobile-board-lane.png` and `docs/captures/responsive-capture.json`; refreshed the filtered and top narrow frames from the current fixture.

**Verification:** overview fixture 18 passed with zero runtime exceptions and zero CSP violations; native package checks and repository tests rerun after the correction pass.

**Independent verdict:** `ship` for the scoped source and fixture-verified experience, with the live-device review items in `quality-report.md` remaining human-owned.

## Round 4: post-correction recheck

**Evidence:** a fresh critic rechecked the final filtered, narrow, disconnected, and board-lane captures after the corrections.

**Result:** all four findings were visibly resolved. The filtered frame now labels the retained worker `Worker · filtered out`; the 390px filter reads in a full row; the disconnected capture shows the red topbar marker; and the 390×1200 board lane shows the board inspector, legend, selector, both record panes, and pagers without horizontal overflow. **Verdict: `ship`.**

## Verdict

`ship` for the scoped source and fixture-verified experience, with the human live-device review item above recorded in `quality-report.md`.
