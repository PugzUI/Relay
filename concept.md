# Concept: Signal Lattice

## The organizing idea

Relay is a small field of sources and destinations. Devices and workers are the upper signal tier; boards and committed records are the lower record tier. The topology is therefore composed as a lattice rather than a list. Orthogonal paths show relationships, while the inspector acts as a stable measurement rail for the selected object.

The visual idea is deliberately quiet. The product communicates through topology, edge weight, selection markers, and real state labels. Lime marks activity and focus; teal identifies board data; gold carries identifiers and record metadata; red is reserved for denied or failed state.

## Considered directions

### 1. Signal lattice, selected

**Thesis:** turn the existing topology into a top-down circuit of real state.

**Metaphor:** source tier, routing tier, record tier.

**PugzUI relationship:** keeps Relay's black field, one-pixel divisions, compact type, square controls, and restrained lime activity while changing only the spatial reading.

**Typography and composition:** small technical labels and medium-weight interface text; upper and lower tiers are separated by a thin horizontal rule instead of card chrome.

**Material and lighting:** flat black surfaces, quiet edge contrast, and no glow. A committed pulse is a bounded line event, not ambient decoration.

**Motion and interaction:** selection persists, filters reduce the lattice, expansion reveals the full branch, and a committed record travels along the existing path once.

**Recognition:** the immediate two-tier topology with a lime left rule and fixed inspector.

**Risk:** a circuit metaphor can become schematic or visually cold if the hierarchy loses readable labels.

### 2. Docked observatory

**Thesis:** make the topology a movable workbench with edge drawers for diagnostics and boards.

**Metaphor:** an instrument panel around a central instrument.

**PugzUI relationship:** shares the flat operational surfaces but introduces stronger docking affordances.

**Typography and composition:** denser side rails with more compact metadata and fewer persistent labels in the center.

**Material and lighting:** panel seams and selected rail edges would carry most hierarchy; no glow would be used.

**Motion and interaction:** drawers open and close, selected objects pin, and board details become destinations.

**Recognition:** persistent left and right rails framing a mutable center.

**Risk:** it adds a second spatial model and more interaction cost than Relay needs, and it would push implementation toward a docking runtime.

### 3. Ledger terminal

**Thesis:** make committed records the primary composition and let topology appear as supporting context.

**Metaphor:** a live field notebook with an index of sources.

**PugzUI relationship:** strongly compatible with compact typography, tabular numerals, and explicit state language.

**Typography and composition:** monospaced records would dominate the page, with topology compressed to a narrow index.

**Material and lighting:** almost entirely flat text and separators.

**Motion and interaction:** new records append, selection jumps to a source, and filters become query controls.

**Recognition:** a high-density chronological record stream.

**Risk:** it makes spatial relationships harder to see and weakens the visual distinction of devices, workers, and boards.

## Selection rationale

The signal lattice best satisfies the brief because it adds a memorable composition without changing the existing state model or introducing a new runtime. It improves first-glance orientation, keeps the inspector available, and gives the existing committed-event pulse a clear path to travel. The greatest risk is schematic dryness; that is addressed with strong type hierarchy, role-specific edge accents, and a deliberate amount of negative space around the two tiers.

## Signature moments

1. **First impression:** the eye lands on the lime-ruled Topology heading, then reads Devices / Workers above Boards as one field. The inspector is visible without covering the composition.
2. **Interaction:** selecting a worker or board moves a single clear marker and updates the inspector without displacing the topology. Keyboard arrows follow the same order as pointer selection; filtering narrows the field and preserves context.
3. **Transformation:** a real committed event turns the relevant orthogonal relationship into a short lime signal that travels between the source and board, then settles into the committed records list. Repeating the action produces another bounded event rather than continuous spectacle.
