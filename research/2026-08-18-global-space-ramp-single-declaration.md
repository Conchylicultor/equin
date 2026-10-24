# The spacing ramp gets one declaration, generated from app.css

## Context

The closed 8-step spacing ramp (`none | 2xs | xs | sm | md | lg | xl | 2xl`) is
currently declared **twice** as a TypeScript union, and its step→class tables are
written out **fourteen** times across five files.

- `SpaceStep` — `plugins/primitives/plugins/css/plugins/spacing/web/internal/stack.tsx`
- `RailStep` — `plugins/primitives/plugins/css/plugins/rail/core/internal/rail-class.ts`

They were not duplicated by choice. `SpaceStep` lives in `web/`, and `railClass()`
sits in `core/` so both runtimes can call it. The boundary config
(`plugins/framework/plugins/tooling/plugins/boundaries/boundary-config.ts`) sets
`core: ["core"]` — a `core/` file may import from other `core/` runtimes and
nothing else — so `rail/core` cannot reach `spacing/web`. The second union exists
purely to satisfy that rule, and `rail-class.ts` says so in a comment: *"The two
must stay the same 8 steps; they are the same density ramp read twice."*

Nothing enforces it. Adding a ninth step, renaming one, or removing one updates a
single side and the drift is **silent**: the ramp is backed by `--space-*` density
tokens and its class names are literal `Record<Step, string>` tables, so a step
present in one union and absent from the other yields a missing utility rather
than a type error. The same pressure recurs for every future `core/`-side
consumer.

The literal tables are duplicated for a real reason — Tailwind emits an
`@utility` only for a literal token its scanner finds, so a step can never be
spliced into a class name at a call site. But the literals already exist in one
authoritative place: **app.css**, which declares all 112 of them.

**Outcome:** app.css becomes the ramp's single source of truth. The step set and
every family's literal class table are *generated* from it into one `core/`
module both runtimes import. A step that exists in TypeScript but has no
`@utility` behind it becomes unspellable.

This mirrors a precedent that already exists one problem over:
`custom-utilities.generated.ts` is generated from app.css's `/* twmerge: … */`
markers by
`plugins/framework/plugins/tooling/plugins/codegen/core/custom-utilities-gen.ts`,
whose own doc comment states the goal — *"app.css is the SINGLE SOURCE OF TRUTH …
the membership-drift bug class becomes structurally impossible."* We extend the
same pipeline rather than inventing a second mechanism.

## The full duplication (what this removes)

| Site | What is duplicated |
| --- | --- |
| `spacing/web/internal/stack.tsx` | `SpaceStep` union + `GAP_CLASS` |
| `spacing/web/internal/inset.tsx` | 7 tables (`P_`/`PX_`/`PY_`/`PT_`/`PR_`/`PB_`/`PL_CLASS`) |
| `rail/core/internal/rail-class.ts` | `RailStep` union + 4 tables (`RAIL_`/`RAIL_X_`/`RAIL_Y_`/`RAIL_OWE_CLASS`) |
| `column/web/internal/column.tsx` | `GAP_CLASS`, byte-identical to stack's |
| `sticky/web/internal/sticky.tsx` | `spaceLength()` — the `var(--space-<step>)` / `0` resolver |
| `pin/web/internal/pin.tsx` | `edgeLength()` — the same resolver plus negation |

Fourteen class tables, two unions, two length resolvers.

**Correction (found during implementation):** fifteen, not fourteen. `grid` and
`floating-action` each carry a sixteenth/seventeenth copy of `GAP_CLASS` too —
both with a co-located comment explaining why the literals had to live locally.
Same duplication class, folded into the same migration.

## Design

### The new plugin

`plugins/primitives/plugins/css/plugins/space-ramp/` — `core/` only (precedent:
`framework/plugin-id`, `primitives/keyset` are core-first plugins; a `core` barrel
is a plain re-export file with no `PluginDefinition`).

It owns **what the steps are and what class each names**. `spacing` keeps
`<Stack>` / `<Inset>` / `insetClass` and the `no-adhoc-spacing` lint rule; `rail`
keeps `railClass` and the rail-mode semantics. Both become consumers.

Placement: it is deliberately *not* `spacing/core`. `rail` importing a plugin
called "spacing" to get `rail-x-md` reads wrong, and the ramp module would become
a grab-bag under the wrong owner's name. A neutral leaf is imported by all
fourteen families' owners without either owning the other.

### app.css declares the ramp

Two new comment declarations, in the same idiom as the existing
`/* @twmerge group … */` section decls:

```css
/* @ramp steps: none 2xs xs sm md lg xl 2xl */
/* @ramp families: gap gap-x gap-y p px py pt pr pb pl */   ← spacing section (~line 946)
/* @ramp families: rail rail-x rail-y rail-owe */           ← rail section (~line 520)
```

Families are **declared, never inferred from suffixes**. Suffix discovery would
sweep in `control-xs/sm/md/lg`, `control-icon-*` and `control-min-*` — which share
four suffixes with the ramp but are a different (4-step) scale — and would flag
them as incomplete ramp families. Today's declared set is exactly the 14 families
that carry all 8 steps.

### The generator

`plugins/framework/plugins/tooling/plugins/codegen/core/space-ramp-gen.ts`,
shaped like its sibling `custom-utilities-gen.ts` (same trio:
`renderSpaceRamp` in-memory / `generateSpaceRamp` write-on-diff /
`spaceRampManifestPath`). It reads app.css **by path** via `fs` — it must not
statically import the ui-kit plugin, same constraint the sibling documents.

Reuse rather than re-implement: `custom-utilities-gen.ts` already has
`maskCommentBodies()` (replaces comment bodies with same-length spaces so a prose
mention of `@utility` is not mistaken for a declaration, while byte offsets stay
valid) and the `@utility` declaration scan. Extract both into a shared
`app-css-utilities.ts` in the same directory and have both generators import it,
so app.css has one parser.

Validation — each of these is a **check failure**, reported with the offending
name, not a crash (the sibling check already models this: a thrown
marker-validation error is caught and returned as the failure message):

- exactly one `@ramp steps:` decl (zero or two is an error);
- at least one `@ramp families:` decl; the union is deduped, file order preserved;
- for every declared family × every step, `@utility <family>-<step>` must exist in
  app.css. This is the load-bearing one: it is what makes "add a step to the TS
  union without adding the CSS" impossible, and what catches a rename that
  half-lands across the 14 families.

The reverse direction (an `@utility p-<x>` whose `<x>` is not a step) is
deliberately **not** an error — `p-chip`, `p-control`, `p-row`, `p-card` are
legitimate non-ramp members of the `p` prefix.

### The generated module

`space-ramp/core/ramp.generated.ts`:

```ts
export const SPACE_STEPS = ["none", "2xs", "xs", "sm", "md", "lg", "xl", "2xl"] as const;

export const RAMP_CLASSES = {
  gap:   { none: "gap-none", "2xs": "gap-2xs", /* … */ },
  p:     { none: "p-none",   "2xs": "p-2xs",   /* … */ },
  "rail-x": { none: "rail-x-none", /* … */ },
  // … 14 families
} as const;
```

`space-ramp/core/index.ts` (hand-written) exports:

- `SPACE_STEPS`, `type SpaceStep = (typeof SPACE_STEPS)[number]`
- `type RampFamily = keyof typeof RAMP_CLASSES`
- `rampClass(family: RampFamily, step: SpaceStep): string` — a wrong family or a
  wrong step is a tsc error, and the class it returns is a literal from a scanned
  file, so the Tailwind-scanner constraint is satisfied by construction.
- `spaceLength(step: SpaceStep): string` — `step === "none" ? "0" : `var(--space-${step})``,
  the one home for what `sticky` and `pin` each hand-roll. Deliberately a formula,
  not a generated table: the var name is not a scanned class (interpolation is
  safe here), and app.css's own fallback-less `var(--space-<step>)` references are
  already guarded against the density token group by the existing
  `css-vars-supplied` check.

Tailwind scanning: the file sits under `plugins/`, which the `@source` glob covers
and the `tailwind-scan-covers-classes` check enforces.

### Registration

One entry in `preBarrelManifests`
(`plugins/framework/plugins/tooling/plugins/codegen/core/pre-barrel-manifests.ts`)
— that file is the single registration point, and the membership rule fits
exactly: the renderer is barrel-free (reads app.css by path only) and the manifest
IS reached at module-load by a web barrel (`spacing/web` → `Stack`). This is the
same slot `customUtilities` occupies, for the same two reasons.

### The check

New sub-plugin
`plugins/framework/plugins/tooling/plugins/checks/plugins/space-ramp-in-sync/check/index.ts`,
copied from its sibling `app-css-utilities-in-sync/check/index.ts`: re-render in
memory, `formatGenerated`, byte-compare against the committed file; a thrown
validation error becomes the failure message. Checks are discovered from
`check/index.ts`, so `./equin build` regenerates `check.generated.ts` — no
registry edit.

### Resulting chain

```
density token group  --space-*        (ui/tokens/density/shared/group.ts)
      ▲ css-vars-supplied  [existing]
app.css  @ramp decls + 112 @utility   ← the one declaration
      │ space-ramp-gen  →  space-ramp-in-sync  [new]
      ▼
space-ramp/core/ramp.generated.ts     SPACE_STEPS · RAMP_CLASSES
      │ tsc
      ▼
spacing · rail · column · cluster · inline · sticky · pin · detail-sections
```

## Implementation

1. **Extract the shared app.css parser.** New
   `codegen/core/app-css-utilities.ts` holding `maskCommentBodies()` and the
   `@utility` declaration scan, lifted verbatim out of `custom-utilities-gen.ts`;
   point that generator at it. No behaviour change — `app-css-utilities-in-sync`
   must still pass untouched, which is the regression test for this step.

2. **Declare the ramp in app.css.** Add the `@ramp steps:` decl to the spacing
   section header comment (~line 946) and the two `@ramp families:` decls to the
   spacing and rail section headers.

3. **Write `space-ramp-gen.ts`** + register in `preBarrelManifests` + export from
   `codegen/core/index.ts`.

4. **Create the plugin**: `space-ramp/{package.json,CLAUDE.md,core/index.ts}` plus
   the committed `core/ramp.generated.ts` placeholder (the sibling manifests are
   all committed; `generated-artifacts-normalized` and the in-sync check both
   expect the file to exist).

5. **Add the `space-ramp-in-sync` check** sub-plugin (+ its `package.json` and
   `CLAUDE.md` — `plugins-have-claudemd` enforces the latter).

6. **Migrate the consumers.** Every `SpaceStep` importer moves to
   `@plugins/primitives/plugins/css/plugins/space-ramp/core`. This is required,
   not cosmetic: re-exporting `SpaceStep` from `spacing/web` would be a
   cross-plugin re-export, which `plugin-boundaries` rejects transitively and at
   name level. Roughly ten files — `pin`, `sticky`, `column`, `cluster`,
   `inline`, `detail-sections`, `page/editor/internal/page-column.ts`, plus
   `spacing`'s own two internals.

   - `stack.tsx` — delete `SpaceStep` + `GAP_CLASS`; `rampClass("gap", gap)`.
   - `inset.tsx` — delete 7 tables; `insetClass` keeps its `cn()` and its
     general→specific ordering, bodies become `pad && rampClass("p", pad)` etc.
   - `column.tsx` — delete its `GAP_CLASS`.
   - `rail-class.ts` — delete `RailStep` + 4 tables; `RailSides` fields become
     `SpaceStep`; keep the `rail`/`owe` discriminated union and the `.join(" ")`
     (still no `cn()` — it is a web export a `core/` module may not import).
   - `sticky.tsx` / `pin.tsx` — delete `spaceLength`/`edgeLength`; call
     `spaceLength()`, with `pin` keeping only its `calc(… * -1)` outset wrapper.

7. **Update the prose.** `spacing/CLAUDE.md` (the scale table moves to the new
   plugin; spacing's doc points at it and keeps the Stack/Inset/enforcement
   sections), `rail/CLAUDE.md` (drop the "two unions, same ramp read twice" note),
   new `space-ramp/CLAUDE.md`, and the app.css section comments. `./equin build`
   regenerates the autogen blocks and `docs/plugins-*.md`.

## Verification

- `./equin check` — the whole suite. Specifically `space-ramp-in-sync`,
  `app-css-utilities-in-sync` (must be unaffected by step 1),
  `plugin-boundaries`, `tailwind-scan-covers-classes`, `css-vars-supplied`,
  `pre-barrel-manifests-complete`, `plugins-registry-in-sync`, `type-check`.
- **Prove the generator is load-bearing** (do this before wiring consumers, and
  revert after): comment out `@utility gap-lg` in app.css → `space-ramp-in-sync`
  must fail naming `gap-lg`. Add `3xl` to the `@ramp steps:` decl without adding
  any `@utility` → must fail listing the 14 missing classes. Add `3xl` properly
  across all 14 families **and** the density group → build regenerates, and the
  union widens everywhere with no other edit.
- `./equin build`, then `./equin test plugins/primitives/plugins/css`
  (picks up `sticky`'s existing pure `stickyClasses` test and ui-kit's
  `control-size.test.ts`).
- Visual regression is the real risk — a silently-dropped utility looks like
  flattened padding, not an error. Load
  `http://<worktree>.localhost:9000` and compare against
  `http://singularity.localhost:9000` on surfaces that exercise the rail and the
  ramp together: a task detail (detail-sections' `railClass`), the Pages editor
  (`BLOCK_INSET`), a Miller column layout, and a pane with a sticky header. Then
  switch the Density preset (Settings → Appearance) between Comfortable and
  Compact and confirm gaps, insets and rails still move together.
- Spot-check the built CSS actually contains the ramp: after a build, grep the
  emitted stylesheet for `rail-x-md` and `pl-2xs` — present means the generated
  `core/` literals are being scanned from their new home.

## Out of scope (worth a follow-up task)

`app-css-utilities-in-sync`, `data-views-in-sync`, `token-group-vars-in-sync` and
the new `space-ramp-in-sync` are four near-identical "render in memory,
byte-compare, hint to rebuild" checks. Since `preBarrelManifests` already lists
the manifest set as data, one generic `manifests-in-sync` check driven by that
list would delete three of them. Not folded in here — it churns unrelated checks
and would obscure this change's diff.
