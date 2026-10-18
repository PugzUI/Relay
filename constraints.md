# Constraints and boundaries

## Product and visual constraints

- `DESIGN.md` is the project-level PugzUI theme. Its colours, compact typography, square geometry, flat surfaces, explicit state language, and reduced-motion rules are binding.
- Existing Relay behavior must remain real. The UI cannot invent traffic, readiness, metrics, testimonials, or fake delivery.
- The topology must continue to use the existing Lit light-DOM components and native SVG routing.
- The existing bounded committed-event pulse is preserved. No idle animation, entrance choreography, spring runtime, or uncontrolled timer was added.
- Every visible control must remain keyboard and pointer reachable, with an explicit empty, denied, cached, loading, or failure state where the product supports one.

## Technical constraints

- Node package and existing build scripts are the reproducible toolchain.
- No React, prebuilt dashboard kit, Dockview runtime, ELK runtime, second state engine, or generated raster art is introduced.
- Strict content security policy remains enabled.
- Local fonts are preferred. The implementation uses the existing `IBM Plex Sans` body fallback and local `IosevkaTerm NFM`/`CommitMono Nerd Font` mono stack when present.
- The responsive contract covers 320, 360, 390, 760, 1000, and 1440 pixel compositions, with 200% text scaling and reduced-motion verification.

## Evidence boundaries

- The fixture browser uses a real isolated Relay store and broker, but it is not a native agent or production network qualification.
- The captures prove the rendered UI and fixture state transitions. They do not prove remote deployment, native-agent permissions, or host-service behavior.
- No external image, Inkscape asset, Blender scene, or third-party visual reference is needed because the subject is a data-native operational topology and the approved material language is flat code-rendered UI.
- The initial critic-agent spawn was unavailable, but an independent visual/interaction review was completed in the correction pass and is recorded as Round 3 in `ledger.md`. A representative live-device review remains human-owned.
