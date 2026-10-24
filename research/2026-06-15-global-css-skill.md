# `css` skill — CSS/layout mental model + primitive index (Phase 0, task 1)

## Context

Layout is the one design dimension in this codebase with **no semantic primitive
and no enforcement**. Raw flex/grid/positioning utilities appear ~1,640 times
across ~430 files, each call site re-deriving a space-sharing negotiation by hand
— which is why the `CollapsibleCard` header churns endlessly (chips wrapping →
path overflowing → badge overlapping path). The cure already works for other
dimensions: 9 `no-adhoc-*` lint rules redirect raw utilities to closed semantic
primitives, and the `theme` skill makes the token/color/preset surface
discoverable. There is no equivalent map for **how to compose boxes**.

This task is **Phase 0, task 1 only** from
[`research/2026-06-15-global-css-layout-primitives-vision.md`](2026-06-15-global-css-layout-primitives-vision.md):
write a discoverable `css` skill capturing the layout mental model + an index of
the layout primitives, cross-linking `theme`, and register it in the root
`CLAUDE.md`. It does **not** build any primitive (Frame/Grid/Cluster/Center/
Overlay) or the `no-adhoc-layout` lint rule — those are Phase 1/2. The skill is
the discovery surface that lands first.

Intended outcome: an agent about to hand-roll `flex … min-w-0 truncate` instead
reads one doc, internalizes "container owns space-sharing, leaf owns truncation,
write the role not the mechanics," and reaches for the right primitive.

## Decision (confirmed with user)

The vision names primitives that **do not exist yet** (Frame, Grid, Cluster,
Center, Overlay) and a `no-adhoc-layout` rule that is also future work. The skill
will **index existing primitives as actionable NOW** and list the not-yet-built
set in a clearly-labeled **"Planned"** subsection pointing back to the vision doc
— honest today, forward-compatible as each primitive lands. No agent is ever told
to import a component that doesn't exist.

## What exists today (verified inventory)

Actionable now, to be indexed as usable:

| Primitive | Import path (`@plugins/primitives/plugins/…/web`) | Role | Exports |
|---|---|---|---|
| `Stack` / `Inset` | `spacing/web` | 1-D flow container (dir/gap/align/justify/wrap) · padding container | `Stack`, `Inset` |
| `TruncatingText` | `truncating-text/web` | **the** truncation leaf — bakes in `min-w-0 + truncate` | `TruncatingText` |
| `Row` / `SectionHeaderRow` | `row/web` | interactive row (list/menu/nav/tree/section-header) | `Row`, `SectionHeaderRow` |
| `Surface` | `surface/web` | elevation roles (sunken/base/raised/overlay) | `Surface` |
| `Card` | `card/web` | raised + padded chrome (`Surface raised` + pad) | `Card` |
| `ViewportOverlay` | `viewport-overlay/web` | portal-to-body `fixed inset-0` + z-layer + theme-scope | `ViewportOverlay` |
| `ResponsiveOverflow` | `responsive-overflow/web` | progressively hide children that don't fit | `ResponsiveOverflow`, `useResponsiveOverflow` |

Confirmed **NOT yet existing** (→ "Planned" section): `frame`, `grid`,
`cluster`, `center`, `overlay` primitives, and the `no-adhoc-layout` lint rule.

## Implementation

### 1. Create `.claude/skills/css/SKILL.md`

Mirror the structure of [`.claude/skills/theme/SKILL.md`](../.claude/skills/theme/SKILL.md)
and the frontmatter convention of `debug`/`theme` (YAML block scalar `>`,
`name:` = dir id, description ending in a "Read BEFORE …" trigger).

**Frontmatter:**
```yaml
---
name: css
description: >
  Map of the CSS/layout mental model and composable layout primitives —
  containers share space, leaves truncate, write the role not the mechanics.
  Read BEFORE any layout, structure, or CSS-composition work.
---
```

**Sections (in order):**

1. **`# CSS & Layout`** — one-paragraph high-level map intro (mirrors theme's
   "High-level map of where to look").

2. **`## Mental model`** — the prose core, the Part-1 principles from the vision,
   condensed to the load-bearing rules:
   - Every box has exactly one job: **container** (arranges children, declares
     direction + how slack is shared) **or** content **leaf** (sizes to itself;
     rigid, flexible, or truncating). Fusing both onto one
     `<div className="flex … min-w-0 truncate">` is the source of the bug class.
   - **Space-sharing is a container property, declared once** — never negotiated
     per child with sprinkled `min-w-0`/`shrink-0`/`flex-1`.
   - **The shrink hierarchy is explicit and total** — for any row that can
     overflow, "what gives first?" has one answer in one place (rigid identity
     never shrinks → secondary metadata truncates first → primary content last).
   - **Prefer the layout mode where the bug is unrepresentable** — `rigid|flex|
     rigid` is canonical Grid (`auto minmax(0,1fr) auto`); an `auto` track can't
     collapse under its rigid content, so "container crushed by its own chip"
     cannot happen. Choose the mode that forbids the bug over one that lets you
     avoid it.
   - **`min-width: 0` is a deliberate leaf decision, never a container reflex** —
     exactly one primitive (the truncation leaf) owns it.
   - **Semantic intent over visual mechanics** — write `content`/`meta`/`stack
     with sm rhythm`; the primitive owns the mechanics and fixes them once,
     globally. This is "CSS-in-semantics," the same philosophy as
     `spacing`/`text`/`surface`.

3. **`## Layout primitives`** — enumerated, each `→ use X for Y` with the web
   barrel path, covering ONLY the existing set (table above): Stack, Inset, Row,
   TruncatingText (the mandatory truncation leaf), Surface, Card, ViewportOverlay,
   ResponsiveOverflow. Link each to its `plugins/…/CLAUDE.md` as `theme` does.

4. **`## Planned primitives`** — clearly labeled "not built yet — see the vision
   doc": Frame (named-slot row: `leading`/`content`/`meta`/`trailing`, owns the
   shrink hierarchy — the `CollapsibleCard` fix), Grid (explicit tracks), Cluster
   (wrap-friendly chip group), Center, Overlay (sanctioned positioning). One line
   each on intended role + a link to
   [`research/2026-06-15-global-css-layout-primitives-vision.md`](../../../research/2026-06-15-global-css-layout-primitives-vision.md).

5. **`## Design-standard enforcement`** — state the principle "no raw layout
   utilities in feature code; one escape valve with a named reason
   (`eslint-disable … -- <reason>`)". Note `no-adhoc-layout` is **planned**
   (cross-link the vision doc). **Cross-link `theme`'s enforcement list** rather
   than duplicate it: the split is **`css` owns *how to compose boxes* (layout/
   structure/truncation/positioning); `theme` owns *tokens/color/preset* and the
   typography/radius/surface/z-index/control/icon standards.** Point to
   [`.claude/skills/theme/SKILL.md`](../.claude/skills/theme/SKILL.md).

6. **Self-improvement footer** — copy `theme`'s closing line: "If something was
   missing from this skill, report it (`add_task` or tell the user) so it gets
   added."

Path note: `theme/SKILL.md` links to plugins with `../../../plugins/…` (skill
file is 3 levels under repo root). Use the same relative depth from
`.claude/skills/css/SKILL.md`.

### 2. Register in root `CLAUDE.md`

Insert one bullet immediately **after** the `theme` skill bullet (currently the
last skill bullet under `## Instructions → ### Agent Workflow Rules`), mirroring
its phrasing:

```
- Before any layout / structure / CSS-composition work, read the `css` SKILL ([`.claude/skills/css/SKILL.md`](.claude/skills/css/SKILL.md)) — the layout mental model (containers share space, leaves truncate) and the composable layout-primitive index; pairs with `theme` (tokens/color/preset).
```

## Critical files

- **Create:** `.claude/skills/css/SKILL.md`
- **Edit:** `CLAUDE.md` (root) — add the `css` skill bullet after the `theme` bullet
- **Mirror:** `.claude/skills/theme/SKILL.md` (structure, frontmatter, footer, relative-link depth)
- **Source of truth for content:** `research/2026-06-15-global-css-layout-primitives-vision.md` (Parts 1–3)

## Verification

- **No code/build impact** — this is docs + a skill file. No `./equin build`
  required for the skill to be picked up.
- **Frontmatter sanity:** confirm `.claude/skills/css/SKILL.md` parses like its
  siblings (`name: css`, block-scalar `description`).
- **Link integrity:** every `→ CLAUDE.md` / vision-doc / `theme` link resolves
  from the skill's location (relative depth matches `theme/SKILL.md`).
- **Accuracy gate:** every primitive listed under `## Layout primitives` exists
  today with the exact barrel path in the inventory table; the future set lives
  only under `## Planned primitives`.
- **Discoverability:** the new bullet appears in root `CLAUDE.md` next to `theme`.
- Optional: `./equin check` stays green (no checks gate skill docs, but
  confirms nothing was disturbed).
