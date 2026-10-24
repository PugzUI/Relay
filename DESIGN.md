# Relay Design System

## Authority and scope

This is Relay's portable visual contract. `ui/style.css` owns the executable CSS variables. Relay uses locally bundled Lit, native SVG and CSS. It does not require private tooling, a remote font service, a CDN, React or a dashboard kit at runtime. The official AHP client SDK supplies host/session state; the browser must not maintain a duplicate durable data model.

Use a dense, flat operational workspace: black and neutral surfaces, readable light text, deliberate one-pixel divisions, lime activity and square corners. Content and **host-authoritative AHP state** determine the display. Show actual host/provider/session topology and explicit connecting, live, stale, empty, permission-needed and failure states. Never invent agent traffic, readiness, inference, model results or completion. Session creation is not proof of a completed turn.

## Token structure

- `c-*`: palette and color roles.
- `f-*`: font families; `fs-*`: type sizes; `fw-*`: weights; `lh-*`: line heights.
- `sp-*`: spacing only.
- Dimensions use `w` / `h` for width / height, `bd` for border, `ctrl` for control and `bp` for breakpoint. Keep each role independent.
- Use concise role names; omit redundant project prefixes. Do not merge independent roles to shorten names.

Alias only deliberate relationships. Equal values are not evidence that roles should change together. Icons do not alias type sizes or spacing. Title bounds do not alias pane padding. Target width does not alias target height. Border width, pane seam, focus width, focus offset, slider track and press distance remain independent, even when values coincide.

Components may alias authoritative roles rather than retain a competing palette. Optional interoperability names such as `background`, `primary`, `input`, `ring` and `sidebar` may alias these roles when consumers need them. They are not framework dependencies or another configuration engine. No generated token file is required by the application.

## Palette and state pairs

| Token          | Value     | Role                                                   |
| -------------- | --------- | ------------------------------------------------------ |
| `c-bg`         | `#000000` | Canvas                                                 |
| `c-bg-alt`     | `#070707` | Recessed regions and default controls                  |
| `c-surface`    | `#0F0F0F` | Raised neutral surfaces                                |
| `c-hover`      | `#1C1C1C` | Neutral hover                                          |
| `c-active`     | `#212121` | Selected neutral rows                                  |
| `c-bd`         | `#070707` | Quiet decorative division                              |
| `c-bd-soft`    | `#141414` | Inner decorative division                              |
| `c-sep`        | `#303030` | Section and record separators                          |
| `c-fg`         | `#F4F4F4` | Ordinary text and record payloads                      |
| `c-bright`     | `#FFFFFF` | Highest-priority emphasis                              |
| `c-secondary`  | `#C2C2C2` | Supporting text                                        |
| `c-muted`      | `#9A9A9A` | Metadata and current graph lines                       |
| `c-muted-base` | `#7F7F7F` | Necessary control boundaries and uncertain graph lines |
| `c-accent`     | `#C4FF00` | Activity, focus and primary action                     |
| `c-on-accent`  | `#000000` | Foreground on lime; independent of canvas color        |
| `c-data-gold`  | `#C9A227` | Optional labeled comparison data                       |
| `c-data-teal`  | `#00C4A0` | Optional labeled comparison data                       |
| `c-danger`     | `#F43434` | Error marker                                           |
| `c-warning`    | `#FFC400` | Warning marker                                         |

`c-input` deliberately aliases `c-muted-base`; `c-focus` aliases `c-accent`.

| State role                                                         | Pairing                                 |
| ------------------------------------------------------------------ | --------------------------------------- |
| `c-ctrl-bg` / `c-ctrl-fg` / `c-ctrl-bd`                            | `c-bg-alt` / `c-fg` / `c-input`         |
| `c-ctrl-hover-bg` / `c-ctrl-hover-bd`                              | `c-hover` / `c-secondary`               |
| `c-primary-bg` / `c-primary-fg` / `c-primary-bd`                   | `c-bg` / `c-accent` / `c-accent`        |
| `c-primary-hover-bg` / `c-primary-hover-fg` / `c-primary-hover-bd` | `c-bg` / `c-accent` / `c-bright`        |
| `c-link-current` / `c-link-uncertain` / `c-link-event`             | `c-muted` / `c-muted-base` / `c-accent` |

Primary actions use a black fill and lime text in normal and hover states; generic neutral hover must not override them. Selection uses `c-active`, a visible lime inset marker and a contrast-checked edge. Error text uses `c-fg` plus a separate red marker, not tiny red text on arbitrary surfaces. Current, offline and confirmed-turn links retain distinct stroke/dash treatments. Color never supplies the only state explanation.

Normal text needs at least 4.5:1 contrast and essential non-text boundaries/indicators at least 3:1 on their actual default, hover and selected surfaces. Decorative seams need not meet the essential-boundary threshold. `c-muted-base` is a boundary color, not ordinary text on hover charcoal. Disabled controls use real disabled semantics and opacity .55; they have no hover or press effect.

Standards: [WCAG 2.2 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Typography

Two family definitions only:

- `f-sans`: `"IBM Plex Sans", "Plus Jakarta Sans", "Segoe UI", system-ui, sans-serif`.
- `f-mono`: `"Geist Mono", "IosevkaTerm NFM", "CommitMono Nerd Font", "IBM Plex Mono", "SF Mono", "Consolas", ui-monospace, monospace`.
- `f-legend` aliases `f-mono` for operational legends.

Local font availability may select a fallback. A declared family is not proof that the preferred face is installed. No private font or private-use glyph is required to understand an icon.

| Role                                                                                    | CSS size                                               | Pixel equivalent at a 16px root |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------- |
| `fs-xs`: metadata, IDs, states, legend and keyboard hints                               | `.75rem`                                               | 12px                            |
| `fs-sm`: body, payloads, node names and all interactive labels, including quiet buttons | `.875rem`                                              | 14px                            |
| `fs-md`: section/pane headings                                                          | `1rem`                                                 | 16px                            |
| `fs-lg`: wordmark and stronger headings                                                 | `1.125rem`                                             | 18px                            |
| `fs-title`                                                                              | `clamp(var(--fs-title-min), 2vw, var(--fs-title-max))` | Independent 20px/28px bounds    |
| `fs-metric` / `fs-metric-sm`                                                            | `2rem` / `1.5rem`                                      | 32px / 24px                     |

`fw-ctrl` is 500, `fw-support` 400, `fw-head` 600 and `fw-brand` 650. `lh-body` is 1.5, `lh-label` 1.35, `lh-head` 1.2 and `lh-read` 1.7. Specific operational rows may use their existing readable line heights; do not generate a second type scale from fractional capture values. Preserve tabular numerals for changing counts and measurements. Type and content spacing use relative units so user text scaling can reflow the interface.

## Geometry and layout

All interface corners are `r-none: 0px`. No nested cards, panel shadows, gradients, blur, glass or ornamental glow. The selection inset is a state marker, not panel elevation. Native SVG symbols may use circles where their meaning requires them.

| Independent dimensions                           | Values at a 16px root                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `ctrl-min-h` / `ctrl-min-w`                      | 36px / 36px                                                                                  |
| `touch-min-h` / `touch-min-w`                    | 44px / 44px                                                                                  |
| `btn-w` / `btn-h`                                | Shared 96px / 36px action-button body; height becomes 44px for narrow/coarse-pointer layouts |
| `collapse-w` / `collapse-h`                      | 36px square, or 44px for narrow/coarse-pointer layouts                                       |
| `field-w` / `field-h` / `search-w`               | 208px password field / 36px minimum height / 240px search; fields reflow on narrow screens   |
| `session-select-w` / `session-select-h`          | 256px / 36px minimum height, bounded by available width                                      |
| `key-w` / `key-h`                                | 24px square keyboard hint                                                                    |
| `metric-min-h` / `inspector-field-min-h`         | 120px metric / 60px inspector row; content can grow                                          |
| `icon-xs` / `icon-sm` / `icon-md` / `icon-brand` | 14px / 16px / 20px / 24px                                                                    |
| `node-icon` / `node-icon-sm`                     | 28px / 24px                                                                                  |
| `bw` / `sp-pane`                                 | Independent 1px border / 1px seam                                                            |
| `focus-w` / `focus-gap`                          | Independent 2px / 2px                                                                        |
| Slider track / press-distance authoring slots    | Independent 6px / 1px; no animation requirement                                              |

Compact desktop controls use the 36px targets. At 760px and below, or with a coarse pointer, controls use the independent 44px targets. Collapse controls follow the same target rules; their glyph remains 16px. Targets are real boxes, not overlapping invisible hit areas. Content can grow beyond minimum heights, and focus must remain visible inside scroll regions.

All ordinary action buttons share the same body across default, primary, quiet, hover, focus and disabled states. Node buttons are data-bearing rows, not action-button variants: they retain full track width and content-driven height. Sessions, identities, metadata and section containers retain responsive width and wrapping. Runtime dimensions use rem so browser text preferences scale targets with their labels.

Raw spacing steps `sp-2/4/6/8/10/12/16/20/24/32/40/48` have those pixel equivalents, expressed in rem. `sp-xs/sm/icon/md/lg/xl` may alias steps 2/4/6/10/20/40 within spacing only.

- Controls: 6px block / 12px inline padding.
- Nodes: 12px insets; 4px row / 12px column gaps.
- Records: 16px insets; 6px row / 12px column gaps.
- Panes: 20px default insets, 12px narrow; group gaps use 24/40/48px as the actual composition needs.
- Metrics fill their grid tracks. Long identities and payloads wrap; records preserve payload line breaks and JSON indentation.

The page has a 1600px maximum content width. The host sidebar contains its host count, a compact add-host action and the host list; global fleet metrics appear only once in the main panel. The host connection form does not show persistent credential instructions (its description remains accessible to assistive technology). The topology heading is kept free of duplicate counts, with the Keys action beside the search field. Inspector refresh/protocol controls appear only when a session is selected. The topology inspector is 256px wide, reducing to 208px at the 1100px breakpoint. At 760px and below, the topology and session catalog use one column, the inspector sits beneath, and toolbars wrap. Use `minmax(0, 1fr)` and `min-width: 0`; keep overflow local to regions that need it, not the page.

## State, motion and verification

Preserve a bounded SVG/CSS pulse only for host-confirmed turn completion or cancellation. It does not depict ongoing readiness or current execution authority. Do not add idle animation, springs, entrances or an animation runtime. Reduced motion keeps static state information and removes the moving dash treatment.

Keep explicit loading, empty, disconnected, cached and error labels. Subscribed session/chat state may remain visible through transport failure only when clearly marked stale and controls disabled; reconnect must re-seed from authoritative snapshots. Never portray a queued prompt as accepted until the host echoes it, or a cancellation request as an ended turn until the host confirms it.

Verify the built Relay application, not only the design guide:

- Normal, hover, focus, disabled, selected, loading, empty, cached and error states.
- Tab/Shift+Tab, Enter/Space, Escape and existing topology navigation; no clipped focus.
- 320/360px, 760px and 1440px layouts, plus intermediate inspector layout and coarse-pointer targets.
- 200% text scaling, readable wrapping, and no unintended page-level overflow or clipped controls.
- Actual foreground/background contrast, stable selected data, committed-event pulse expiry and reduced motion.
- Authenticated AHP sessions/permissions, host disconnect/reconnect, strict CSP, local assets and host-owned file changes are verified through a real AHP server.

Static screenshots do not prove real disabled semantics, keyboard behavior, live data or responsiveness. Test the browser against an isolated AHP daemon and ACP fixture, then separately qualify real agent execution. Fixture output is not proof that an authenticated production model can infer, restore a session or make approved file edits.
