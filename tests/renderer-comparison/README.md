# SVG / PixiJS topology comparison

Isolated, disposable renderer fixture. Not the Relay product UI and not evidence of native message delivery. No backend/API access. All nodes and events are explicitly simulated. The production package, dependencies and UI were not changed.

## Run

From the Relay repository root:

```sh
python3 -m http.server 18847 --bind 127.0.0.1 --directory tests/renderer-comparison
```

Open http://127.0.0.1:18847/ . No npm install is needed to run it; the PixiJS 8.22.0 browser bundle and MIT notice are local in `vendor/`. Serve over HTTP, not `file://`, because this uses browser modules.

## Compare

- Identical top-down topology, orthogonal wire routes, shared geometry, clock, events, zoom, pan and selection.
- Message: worker-a → relay → inbox. Work transfer: bounties → relay → worker-c. These are simulated committed events, not requests or delivery receipts.
- Filled signal head = message; hollow head = work. Both travel the same sampled polyline in both renderers, with segmented trailing intensity and an arrival marker.
- SVG uses retained, pooled signal elements and non-scaling wire strokes. Pixi uses Graphics and pixelLine strokes. Both use the same HTML label/control overlay, so the GPU renderer does not pretend canvas alone supplies keyboard accessibility.
- No idle event simulation unless explicitly enabled. Reduced motion initially follows the operating-system setting; in this mode, routes/endpoints are highlighted without traveling signals. Uncheck Reduced motion to inspect movement when the OS requests reduction.
- 7 / 63 / 252-node scenarios. Nodes are repeated fixture clusters, not a representative generated production topology. Zoom in for labels in large scenarios.
- Up to 512 concurrent signals and 20 ledger rows. Expired signals clear; the SVG pool is reused. Pan either pane to move both. Reset clears pulses and restores viewport.
- GPU initialization failure leaves SVG usable and reports Pixi unavailable; comparison measurements are refused.
- Changing simulation controls, interacting with a map, resizing the viewport or hiding the page cancels an active measurement and clears its report instead of publishing mixed-condition timings.

## Security and bundling

The default Pixi bundle failed under the script CSP. The included bundle was built from `import 'pixi.js/unsafe-eval'; export { Application, Container, Graphics } from 'pixi.js';` using esbuild. Despite the module name, this is Pixi's compatibility implementation that avoids generated/evaluated functions. Script CSP remains `script-src 'self'`, without unsafe-eval or unsafe-inline. The small inline type-scale declaration is hash-authorized; the rest of the CSS is external. No CDN, remote font, fetch or Relay connection is used. The vendored renderer is 541,520 bytes, or 155,019 bytes with Python gzip compression; HTTP serving here does not automatically compress it.

The vendored bundle is deliberately committed so this fixture runs without an
install step. `vendor/provenance.json` records its verified SHA-256, build
options, and exact package versions and integrity values. A clean rebuild with
those inputs matched the existing bundle byte-for-byte on 2026-10-17.
`vendor/LICENSES.txt` retains the notices for the bundled dependencies alongside
the original `PIXI-LICENSE`. The colord notice comes from the pinned upstream
source recorded in the provenance file because its npm archive omits that file.
Keep these notices with copied bundles.

## Observed comparison

Chromium headless, WebGL with SwiftShader enabled, 1500×1040, device pixel ratio 1. Each measurement runs for 5 seconds with a bounded simulated pulse load. Renderer order alternates per frame. Values are milliseconds of CPU update/submission, including each pane's shared HTML overlay work. They exclude browser SVG paint and GPU completion. The two panes share a browser/RAF; these are NOT independent FPS tests, GPU benchmarks, hardware qualification, or a production scaling limit.

| Nodes | SVG median / p95 | Pixi median / p95 | Samples per renderer |
| --- | --- | --- | --- |
| 7 | 2.00 / 2.80 ms | 1.70 / 3.30 ms | 300 |
| 63 | 2.10 / 2.80 ms | 1.40 / 2.70 ms | 301 |
| 252 | 2.40 / 3.50 ms | 1.70 / 3.00 ms | 301 |

Pixi had lower median submission cost in this implementation; this is not an apples-to-apples total rendering cost metric because SVG painting is deferred. The visual result itself does not require Pixi. SVG remains the simpler production default for the current product contract. Pixi is worth keeping as an option if actual browser/hardware profiling or richer signal effects justify its added bundle and GPU lifecycle requirements.

## Direct verification

- Both renderers initialized and displayed the same nodes/routes.
- Triggered message and work pulses; inspected screenshots with both in flight.
- Pause froze simulation time; zoom changed both viewports; node selection synchronized.
- Reduced-motion mode, three topology sizes and measurement controls exercised.
- Enter triggered a focused message button; pointer pan produced shared offset `[50,25]`.
- Expired pulse count and visible SVG heads both returned to zero.
- Desktop and 390px mobile screenshots inspected; no page-level horizontal overflow.
- Additional device-pixel-ratio-2 run: canvas backing width 1382 for 691 CSS pixels, no page exceptions.
- Final verification run had zero browser console/page errors. The desktop preview also initialized Pixi and accepted a message trigger.

Limits: no real Relay traffic, physical-GPU performance qualification, independent renderer benchmark, exhaustive accessibility audit or production integration was performed. The headless browser scripts were direct verification of this fixture, not the unrelated project test suite.

## Renderer references

- https://pixijs.com/8.x/guides/components/scene-objects/graphics/graphics-pixel-line
- https://github.com/pixijs/pixijs/releases
- Pixi's installed `lib/unsafe-eval/init.mjs` describes its eval-free shader/uniform compatibility implementation.
