# Derive the custom-utility twMerge registry from app.css (kill the hidden 4th edit)

## Context

Adding a density padding utility (the recent `p-card`) takes **four** coupled
edits, but only three are discoverable:

1. `plugins/ui/plugins/tokens/plugins/density/shared/group.ts` — the `padCard` token var.
2. `plugins/ui/plugins/tokens/plugins/density/web/presets.ts` — per-preset values
   (coupled to #1 by the **documented** `token-group-vars-in-sync` check).
3. `…/css/plugins/ui-kit/web/theme/app.css` — `@utility p-card { padding: var(--pad-card); }`.
4. `…/css/plugins/ui-kit/web/theme/custom-utilities.ts` — add `"p-card"` to the
   `PAD_UTILITIES` array so `cn()`'s tailwind-merge config knows its conflict
   group. **This step is undocumented** — not mentioned at the `app.css` `@utility`
   pad block (the spacing block right below it *does* carry the note, line 232),
   nor in any density/card `CLAUDE.md` — and only surfaces as an
   `app-css-utilities-in-sync` check failure *after* a failed build round-trip.

The registry (`custom-utilities.ts`) encodes two things: **(a)** the enumeration
of class names — pure duplication of what `app.css` already declares — and **(b)**
each family's twMerge conflict classification (`{group:"sg-pad", conflictsWith:["p"]}`
vs `{extend:"p"}` vs `standalone`), which is genuine semantic info not derivable
from the CSS property (both `p-card` and `p-sm` set `padding`, yet land in
different groups).

The drift is entirely in **(a)**. The fix: make `app.css` the single source of
truth for membership, attach the one human-supplied bit **(b)** to each `@utility`
as a co-located marker, and **generate** the registry at build time — mirroring
the existing `token-group-vars.generated.ts` pattern. Adding a utility collapses
to a single edit at the declaration site; the name-mirroring array disappears, so
the drift class becomes structurally impossible — for *every* custom utility, not
just pads. `cn()` runs in the browser and can't read `app.css`, so membership must
be materialized into a committed `.generated.ts` at build time (exactly what the
codegen pipeline already does for other manifests).

Chosen altitude: **structural codegen** (Option A), confirmed with the user.

## Design

### Source of truth = `app.css` (membership + classification)

Annotate `app.css` so the generator can recover the full registry. Two marker
forms, both living in `app.css`:

- **Per-utility marker** — a `/* twmerge: <ref> */` comment associated with each
  `@utility`. `<ref>` is one of:
  - `extend <builtin>` → emits `{ classes, extend: "<builtin>" }`
  - `<sg-id>` (a synthetic group id, must match a group decl below) → emits
    `{ classes, group: "<sg-id>", conflictsWith: [...] }`
  - `standalone -- <reason>` → emits `{ classes, standalone: true, reason: "<reason>" }`
- **Synthetic-group declaration** — one per `sg-*` group, in a section-header
  comment: `/* @twmerge group sg-pad conflicts: p */`. Declared once; members just
  reference the id.

```css
/* Density padding utilities … @twmerge group sg-pad conflicts: p */
@utility p-chip    { padding: var(--pad-chip-y) var(--pad-chip-x); }     /* twmerge: sg-pad */
@utility p-card    { padding: var(--pad-card); }                         /* twmerge: sg-pad */
…
@utility p-sm      { padding: var(--space-sm); }                         /* twmerge: extend p */
@utility focus-ring { … }   /* twmerge: standalone -- additive box-shadow/outline; no single-value built-in group */
```

Association is **brace-counting-free**: split the file on `@utility` boundaries;
each record's `twmerge:` marker is the one between that `@utility` and the next.
Group decls are scanned file-wide separately. The generator **validates and throws
loudly** on: an `@utility` with no marker, an `sg-id` ref with no group decl, an
unknown builtin id (validated against a fixed allow-list owned by the generator —
the stable tailwind-merge group ids), or a `standalone` with an empty reason. This
turns today's silent post-build check failure into an immediate, located build
error at the codegen step.

### Generated output consumed by `cn()`

`generateCustomUtilities` emits
`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/custom-utilities.generated.ts`
with the **same shape `cn()` already consumes** — a typed
`CUSTOM_UTILITY_REGISTRY` (`as const satisfies readonly RegistryEntry[]`) plus the
derived `CustomGroupId` type:

```ts
// AUTO-GENERATED from app.css @utility markers. Do not edit. Run ./equin build.
import type { RegistryEntry } from "./custom-utilities-types";
export const CUSTOM_UTILITY_REGISTRY = [
  { classes: ["p-chip","p-control","p-row","p-card"], group: "sg-pad", conflictsWith: ["p"] },
  { classes: ["p-none","p-2xs", …, "p-2xl"],          extend: "p" },
  …
] as const satisfies readonly RegistryEntry[];
export type CustomGroupId = Extract<(typeof CUSTOM_UTILITY_REGISTRY)[number], { group: string }>["group"];
```

The rich type machinery + the `extend`/`group`/`standalone` wiring documentation
(currently the header of `custom-utilities.ts`) moves to a hand-authored,
**data-free** `custom-utilities-types.ts` (`BuiltinGroupId`, `RegistryEntry`),
imported by both the generated file and `lib/utils.ts`. Only the *data* is
generated. `custom-utilities.ts` is **deleted**.

`lib/utils.ts` changes exactly one import (`./custom-utilities` →
`./custom-utilities.generated`); its twMerge-building loop (lines 10–26) is
untouched. Same-plugin import; `.generated.ts` is git-committed and R9-exempt.

### Wiring (mirrors `token-group-vars`)

- New generator module
  `plugins/framework/plugins/tooling/plugins/codegen/core/custom-utilities-gen.ts`
  exporting `renderCustomUtilities(root): string`,
  `generateCustomUtilities({ root })` (idempotent write-on-diff), and
  `customUtilitiesManifestPath(root)` — same trio shape as
  `token-group-vars-gen.ts`.
- Register in
  `plugins/framework/plugins/tooling/plugins/codegen/core/regen-pipeline.ts`:
  import it and add an `onStep("customUtilities", "custom-utilities manifest", …)`
  call inside `regenerateManifestCodegen`, **before** the `tokenGroupVars` step
  (it only reads `app.css`, no ordering dependency on the plugin tree; place it
  among the CSS-related steps). Export the new functions from
  `…/codegen/core/index.ts`.
- Repurpose the existing check
  `plugins/framework/plugins/tooling/plugins/checks/plugins/app-css-utilities-in-sync/check/index.ts`:
  drop the two-file text-parse; new impl = `readFileSync(generatedFile) !==
  renderCustomUtilities(root)` (wrapped in try/catch so a thrown marker-validation
  error is reported as a check failure, not a crash), `hint: "Run ./equin
  build and commit the regenerated file."` — byte-for-byte the
  `token-group-vars-in-sync` shape. Keep the check id (still keeps app.css ⇄
  registry in sync). Update its `CLAUDE.md`.

### Migration (one-time, mechanical)

Add a marker to every existing `@utility` in `app.css` and a group decl for each
synthetic group, per the current registry mapping:

| marker | utilities |
| --- | --- |
| `extend font-size` | `text-title … text-caption` |
| `extend z` | `z-base … z-max` |
| `extend h` | `h-chrome-bar`, `h-chrome-pane` |
| `extend px` / `pl` / `pr` | `px-chrome` / `pl-chrome` / `pr-floating-bar` |
| `extend gap`/`gap-x`/`gap-y`/`p`/`px`/`py`/`pt`/`pr`/`pb`/`pl` | the `--space-*` ramp families |
| `extend rounded` | `rounded-checkbox` |
| `sg-pad` (conflicts: `p`) | `p-chip`, `p-control`, `p-row`, `p-card` |
| `sg-control-height` (conflicts: `size h`) | `control-xs … control-lg` |
| `sg-control-icon` (conflicts: `size h w`) | `control-icon-xs …` |
| `sg-control-min` (conflicts: `min-h`) | `control-min-xs …` |
| `sg-icon-auto` (conflicts: `size h w`) | `icon-auto` |
| `standalone -- <reason>` | `focus-ring`, `focus-ring-within`, `region-line`, `no-scrollbar` |

The generated registry must come out **semantically identical** to today's
hand-written one (verify by diffing the regenerated file against a snapshot of the
current registry's data).

## Files

- **New**: `…/tooling/plugins/codegen/core/custom-utilities-gen.ts` (generator).
- **New**: `…/css/plugins/ui-kit/web/theme/custom-utilities-types.ts` (hand, types only).
- **New (generated)**: `…/css/plugins/ui-kit/web/theme/custom-utilities.generated.ts`.
- **Delete**: `…/css/plugins/ui-kit/web/theme/custom-utilities.ts`.
- **Edit**: `…/css/plugins/ui-kit/web/theme/app.css` (markers + group decls).
- **Edit**: `…/css/plugins/ui-kit/web/lib/utils.ts` (one import line).
- **Edit**: `…/codegen/core/regen-pipeline.ts` + `…/codegen/core/index.ts` (register).
- **Edit**: `…/checks/plugins/app-css-utilities-in-sync/check/index.ts` + its `CLAUDE.md`.
- **Edit**: `…/css/plugins/ui-kit/CLAUDE.md` + `…/css/plugins/ui-kit/web/theme/CLAUDE.md`
  (point to the marker convention as the way to add a `@utility`).

## Verification

1. `./equin build` — confirm `custom-utilities.generated.ts` is written and
   the build's codegen step + `app-css-utilities-in-sync` check pass.
2. **Semantic-parity check**: diff the generated `CUSTOM_UTILITY_REGISTRY` against
   the pre-change hand registry — the set of `{classes, group/extend/standalone,
   conflictsWith/reason}` entries must be identical.
3. **cn() smoke test** (bun:test, co-located): `cn("p-card p-2")` keeps the last
   (dedupe via the `sg-pad`↔`p` conflict), `cn("text-caption text-sm")` keeps the
   last (no silent strip), `cn("focus-ring shadow-md")` keeps both (standalone).
4. **Footgun-is-gone proof**: add a throwaway `@utility p-test { … }` to `app.css`
   *without* a `twmerge:` marker → `./equin build` must fail **immediately**
   at the codegen step with a located error naming `p-test` (not a silent
   post-build check miss). Then add the marker → build passes and the array never
   had to be touched. Remove the throwaway.
5. `./equin check app-css-utilities-in-sync` and `./equin check
   type-check` green.

## Out of scope

Steps 1–2 (density token schema + presets) keep their own
`token-group-vars-in-sync` coupling — already documented and orthogonal. This plan
only eliminates the undocumented step 4.
