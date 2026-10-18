# Quality report

## Scope

This report covers the Relay overview/topology composition and its existing state interactions after the Signal Lattice update.

## Automated and fixture verification

| Check | Result | Evidence |
|---|---|---|
| repository tests | 245 passed, 0 failed, 0 skipped | `npm test` |
| packaging, syntax, exports, declarations | passed | `npm run check` |
| overview browser fixture | 18 passed | `docs/captures/overview-qa.json` |
| browser runtime exceptions | 0 | fixture metadata |
| CSP violations | 0 | fixture metadata |
| strict package artifacts | passed | `npm run check` |

## Visual evidence

| View | Capture | What it proves |
|---|---|---|
| desktop initial | `docs/frames/01-initial-topology.png` | top-down source/record hierarchy, active path, inspector, real committed state |
| filtered transformation | `docs/frames/02-filtered-transformation.png` | query state, stable inspector, intentional no-match result |
| mobile composition | `docs/frames/03-mobile-composition.png` | narrow recomposition, two-column metrics, stacked topology and controls |
| mobile board lane | `docs/frames/04-mobile-board-lane.png` | 390px lower scroll with board tier, inspector, records, and no horizontal overflow |
| disconnected | `docs/captures/disconnected.png` | explicit disconnected state and recovery affordance |
| denied | `docs/captures/metadata-denied.png` | explicit permission/error state |
| cached | `docs/captures/offline-cached.png` | named offline cached state |
| empty | `docs/captures/empty-store.png` | intentional empty workspace |
| 200% text | `docs/captures/text-200.png` | readable large-text narrow composition |
| signature recording | `docs/recordings/committed-event.webm` | three-second committed-event pulse captured from the functioning fixture |

The fixture exercised 320, 360, 390, 760, 1000, and 1440 pixel compositions, filter, selection, keyboard navigation, collapse/expand, refresh, committed-event feedback, reduced motion, and state recovery. The responsive capture runner also records the 1440px, 1000px, 390px top, and 390px board-lane compositions in `docs/captures/responsive-capture.json`. The captured evidence is generated from an isolated real Relay store and broker.

## Delivered-bundle validation

- `unzip -t` passed for the delivered archive; a fresh extraction contained 89 files, including all required source, records, frames, captures, and recording assets.
- The extracted bundle's CLI smoke path passed: setup, worker registration, session join, message send, and stats read all completed from the extracted files.
- The native approved runtime launched the current source with `npm start -- --no-copy-token` and reported `http://127.0.0.1:4200`; the fixture browser and responsive capture runner then completed against the functioning broker.
- The ordinary restricted scratch runtime cannot launch the extracted `npm start` command because its platform process-identity check reports `unavailable: Process identity cannot be verified on this platform`. This is an environment limitation; the same command launched successfully in the approved native runtime above.

## Accessibility review

- Semantic buttons and inputs remain the interaction primitives.
- Visible focus styling and keyboard navigation are preserved for topology controls and node selection.
- State is communicated with text and markers in addition to color.
- Reduced motion keeps state feedback visible without animation.
- The palette follows the project contrast rules; the captured UI remains readable at compact sizes.
- 200% text evidence is included in `docs/captures/text-200.png`.

## Performance review

- No new continuous animation loop was introduced.
- No new image, shader, WebGL, or heavyweight runtime dependency was introduced.
- Topology geometry remains native SVG and is measured only after relevant state/layout updates.
- Large worker groups are bounded in the initial view and expanded explicitly, which limits first-render DOM and path work without hiding data.
- The fixture completed without runtime exceptions or CSP violations. A production device frame-time trace was not available in this environment.

## Critical comparison against the design brief

1. **Identity:** Relay's black field, compact typography, square geometry, lime activity, teal board role, gold metadata, and explicit red failure states remain intact. Disconnected state now uses the red role marker described by the style bible.
2. **Distinction:** the two-tier signal lattice and role edge system give the overview a structural identity beyond a conventional list.
3. **Motion:** the only moving signal represents a real committed event and preserves the existing path.
4. **Function:** filters, selection, branch collapse/expansion, refresh, inspection, and recovery remain connected to real state. A retained selection is labeled `filtered out` when a query hides it, preserving spatial continuity without implying it remains in the result set.
5. **Responsive behavior:** desktop, tablet, narrow, and 200% text layouts are intentionally recomposed rather than merely cropped.

## Human review items

- Inspect the live experience on a representative desktop and touch device, including a real native-agent session if available.
- Confirm the local IosevkaTerm/CommitMono fonts are present in the intended deployment environment; fallback stacks are defined if they are not.
- Review the committed-event pulse at production frame rate on representative hardware.
- Confirm the final visual balance against current Relay product usage and any future product-specific content density.
- A three-second temporal recording is included at `docs/recordings/committed-event.webm`; it is fixture evidence, so a human should still capture a short live production-device clip before external publication.
