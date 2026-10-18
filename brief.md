# Relay Signal Lattice

## Resolved brief

| Field | Decision | Reason |
|---|---|---|
| mode | application | Relay is an operational product surface with live state, recovery states, and task completion affordances. |
| subject | Relay local message and work topology | The visual work must clarify the relationship between devices, workers, boards, and committed records. |
| audience | Operators and developers inspecting a Relay session | They value truthfulness, fast orientation, readable dense state, and explicit recovery paths. |
| intent | Make the topology immediately legible and make real state changes feel causally visible | The interface should communicate where work is, what is selected, and what happened after an action. |
| environment | Multi-device, with desktop as the primary composition and narrow mobile support | Relay is primarily operated on a desktop but the UI already has a responsive contract. |
| scope | Complete Relay overview surface and its topology interaction | The existing application already owns authenticated state, boards, workers, devices, and committed records. |
| behaviour | Select nodes, filter the topology, collapse branches, expand large worker groups, inspect details, refresh, and observe committed-event pulses | These are existing product actions with real store and broker outcomes. |
| brand | Project root `DESIGN.md` | It is the authoritative local PugzUI theme and executable visual contract. |
| facts | Local repository files and the isolated UI fixture only | Claims about the product must remain traceable to project sources. |
| assets | Procedural code-rendered SVG/CSS and existing local UI assets | The topology is native data, so authored code preserves state truth and responsiveness. |
| references | Local `docs/topology-visual-direction.md` plus the project’s existing implementation | No external visual reference is required to justify a departure from the Relay identity. |
| direction | A top-down signal lattice: source devices and workers resolve into boards and committed records | This creates one spatial reading of the product without adding decorative material. |
| sound | silent | Audio is unnecessary for orientation and would add no essential state information. |
| constraints | Preserve real state semantics, strict CSP, Lit light DOM, native SVG/CSS, square Relay surfaces, compact typography, reduced motion, and responsive behavior | These constraints are explicit in `DESIGN.md`, `AGENTS.md`, and the existing code. |
| autonomy | unattended | The request asks for end-to-end completion and delivery without approval stops. |
| toolchain | Existing Node package, Lit light DOM, native SVG, CSS, and fixture browser tests | Keeping the current architecture protects product behavior and lowers integration risk. |
| sign-off | Working source, reproducible checks, code-rendered frames, captures of important states, design records, quality report, and explicit review items | These are the requested deliverables and the evidence needed to judge the result. |

## Creative decision

The overview now reads as a restrained signal lattice. A lime-accented topology header establishes the focal point. Devices and workers occupy the upper tier, boards form the lower tier, and the inspector remains a stable right rail on wide screens. Existing committed-event SVG paths remain the only moving signal. The composition gets more spatial without inventing activity or turning the operational surface into a decorative dashboard.

## Source of truth

The implementation follows the project-root `DESIGN.md` first, then `AGENTS.md`, the existing Lit components and tests, and the local topology research note. The fixture captures are isolated browser evidence backed by a real in-memory Relay store and broker; they are not a claim about production network delivery.
