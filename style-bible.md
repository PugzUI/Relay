# Style bible

## Central idea

Signal lattice: a top-down operational field where real relationships are drawn as orthogonal paths and each tier has a clear role.

## Composition and geometry

- The overview is a single workspace, not a set of floating cards.
- The topology heading has a two-pixel lime rule on its left edge. It is the focal anchor on every viewport.
- Devices and workers form the upper tier. Boards form the lower tier with a thin separator and additional breathing room.
- The inspector remains a stable right rail on wide screens and moves below the topology on narrow screens.
- Nodes use square corners, one-pixel borders, and a two-pixel role edge. No nested card stacks.
- Worker and board collections use a responsive grid only to keep real branches readable. The grid is content-driven and collapses to one column on narrow screens.

## Palette and roles

| Role | Token | Use |
|---|---|---|
| field | `--c-bg` / `--c-bg-alt` | page field and secondary workspace plane |
| surface | `--c-surface` | topology workspace and inspector background |
| division | `--c-sep` / `--c-bd-soft` | rules, branch edges, and quiet boundaries |
| primary text | `--c-fg` / `--c-bright` | labels and selected values |
| secondary text | `--c-secondary` / `--c-muted` | descriptions, metadata, and supporting labels |
| activity | `--c-accent` | selected node, live committed path, focus edge, and active rule |
| board data | `--c-data-teal` | board role and record destination |
| identifiers | `--c-data-gold` | IDs and metadata that benefit from scanability |
| failure | `--c-danger` | denied, disconnected, and failed state markers |

No gradient, blur, glass, panel shadow, or ornamental glow is part of the material system.

## Typography

- Interface and body: `IBM Plex Sans`, with the existing system fallbacks. Use 12–15px for compact labels and 16px for primary values.
- Technical identifiers and metadata: `IosevkaTerm NFM`, `CommitMono Nerd Font`, or the existing mono fallbacks.
- Body text uses `font-variant-numeric: slashed-zero tabular-nums` for state values and timestamps.
- Weight hierarchy is medium to semibold. Hierarchy comes from grouping, rules, contrast, and alignment before size.
- Headings remain compact. There is no oversized hero scale.

## Materials and lighting

The material is a printed instrument surface: flat black planes, quiet graphite divisions, and high-contrast labels. Role edges provide the minimum colour needed for orientation. The only luminous behavior is the bounded committed-event signal, which reads as data moving through a known route.

## Texture and iconography

The surface is intentionally untextured. Icons are small line or glyph marks already used by the application. Meaning is carried by labels, edges, and state text; icons never stand alone as the only state cue.

## Motion and choreography

- Existing committed-event pulse: bounded, causal, and one-shot.
- Selection and filtering: immediate layout/state updates with no ornamental entrance.
- Expansion: content reveals in place; no spring or stagger runtime.
- Reduced motion: the same state change remains visible as a static path/selection change.
- Idle state is still. Continuous animation would imply work that did not happen.

## Interaction state language

- Focus is a visible lime outline or edge.
- Selected nodes use lime edge weight and a readable status label.
- Boards use teal role accents; workers remain neutral until selected.
- Denied and disconnected states use explicit red text/markers and recovery copy.
- Empty and filtered states use an intentional message in the workspace rather than disappearing controls. A retained inspector labels a selected object as filtered out so continuity is explicit.
- Cached state is named as cached and visually separated from connected state.

## Responsive composition

- Wide: topology and inspector share one row; branches may sit two-up when enough real nodes exist.
- Tablet: topology retains its hierarchy while the inspector narrows.
- Narrow: overview metrics become two columns, topology and inspector become one column, and worker/board branches stack.
- At 200% text size the workspace may grow vertically, but labels remain readable and controls remain reachable.

## Intentional extensions

The top-down lattice and the lime topology rule are new expressions within the existing Relay grammar. They extend the theme by changing spatial hierarchy, not by adding an unapproved material or decorative effect.
