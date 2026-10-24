# Sonata piano-roll "View options" chip

## Context

The Sonata piano-roll HUD (top-right of the lane) already has a host-owned
**`FxToggle`** chip — a popover that lists every visual-effect contribution
generically and lets the user toggle each on/off. It is collection-consumer
clean: each FX plugin ships its own `{ enabled }` config and auto-appears, the
host never names a contributor.

The **other Sonata display configs** (note names in bars, keyboard key labels,
key style) are only reachable from the Settings → Config pane — there is no
quick in-player control. This change adds a second HUD chip, mirroring
`FxToggle`, that surfaces those options via the same slot+contribution pattern,
rendered with the existing config_v2 `FieldRenderer`. Adding a future display
option becomes one slot contribution with zero host edits.

**Scope decision:** surface `showNoteNames` (piano-roll), `labelScope`
(piano-keyboard), and `keyStyle` (keyboard primitive). The piano-roll `spread`
config is intentionally **excluded** — the toolbar jog-wheel (`SpreadWheel`)
already owns live zoom, so a second zoom control would be redundant/confusing.
The slot supports a `fields` subset, so re-adding it later is a one-line change.

## Design

A new **`Sonata.ViewOption`** render slot, owned by the **shell** (the only
cycle-free home — see below). Each config-owning plugin contributes its
descriptor; a new host-owned chip in the piano-roll HUD reads the slot
generically and renders each field via the config_v2 `FieldRenderer`.

```
shell            ── defines Sonata.ViewOption slot (alongside Sonata.Hud)
piano-roll       ── contributes pianoRollConfig (showNoteNames)
                    + HOSTS the ViewOptions chip in the HUD
piano-keyboard   ── contributes pianoKeyboardConfig (labelScope)
                                + keyboardStyleConfig (keyStyle)
keyboard (prim.) ── exports keyboardStyleConfig from its web barrel (stays a leaf)
```

### Why the slot lives in the shell (cycle analysis)

The FX slot lives in `piano-roll` because its contributors are its *children*.
Here the contributors span `piano-roll`, `piano-keyboard`, and the `keyboard`
primitive — and `piano-roll → keyboard` already exists, so a piano-roll-owned
slot the keyboard contributes to would cycle. The `keyboard` primitive must
stay a leaf (it is imported by piano-roll, piano-keyboard, chord-readout,
key-readout — making it depend on the app shell would be a layering violation).

Resolution, mirroring the existing **`Sonata.Hud`** precedent (slot in shell,
rendered by piano-roll, contributed by `key-chip` et al.):
- Slot defined in **shell** (imported by everyone, imports nobody back).
- `keyStyle` is surfaced by **piano-keyboard** (which already imports both the
  `keyboard` primitive and the shell), not by the keyboard primitive itself —
  so the leaf primitive gains no new dependency. The keyboard primitive only
  **exports** its descriptor (already public API territory: its web barrel
  re-exports the `KeyStyle` type from the same `shared/config.ts`).

No new cross-plugin cycles: `piano-keyboard → shell` and
`piano-keyboard → keyboard` both already exist; `piano-roll → shell` and
`piano-roll → config_v2/fields` are existing/legal edges.

### Generic rendering (verified APIs)

- `FieldRenderer` (`@plugins/config_v2/plugins/fields/web`) takes exactly
  `{ field, value, onChange }`. `ConfigFieldContext` is consumed **only** by the
  secret-field renderer — bool/enum/float need no context/`storePath`, so the
  chip renders fields with no extra plumbing.
- `useConfig(descriptor)` → reactive values; `useSetConfig(descriptor)` →
  stable `(key, value) => void` (exactly how `FxToggleRow` drives `enabled`).
- Enumerate a descriptor's fields with `Object.entries(descriptor.fields)`
  (`[key, FieldDef]`); default via `descriptor.defaults[key]` (how
  `config-detail.tsx` does it). The field renderers self-render their labels.
- All three descriptors are already registered via `ConfigV2.WebRegister` — no
  new registration needed.

### Hooks-stability requirement

Like `FxToggle`, each contribution gets its **own row-group component** so the
per-contribution `useConfig`/`useSetConfig` hook count never changes when the
contribution list length changes.

## Files to change

**New slot — shell**
- `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts`
  Add next to `Hud` (line ~171):
  ```ts
  // VIEW OPTIONS — global display prefs surfaced as quick controls in a player
  // HUD chip (note names, key labels, key style, …). Each contributor hands a
  // config_v2 descriptor (optionally a field subset); the host renders fields
  // generically via FieldRenderer. Collection-consumer clean — host never names
  // a contributor.
  ViewOption: defineRenderSlot<{
    id: string;
    config: ConfigDescriptor;
    fields?: string[]; // optional subset/order; default = all descriptor fields
  }>("sonata.view-option", { docLabel: (p) => p.id }),
  ```
  Import `ConfigDescriptor` type from `@plugins/config_v2/core`.

**Host chip — piano-roll**
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/view-options-toggle.tsx` (new)
  Modeled byte-for-byte on `fx-toggle.tsx`:
  - `pointer-events-auto` wrapper + `onPointerDown` stopPropagation (HUD/scrub
    guard — copy from FxToggle).
  - `InlinePopover` (`open/onOpenChange/align="end"/side="bottom"/width="sm"/padding="sm"`),
    `tooltip="Display options"`, trigger = `ToggleChip` with `MdTune` icon
    (matching the translucent-blur HUD pill `className` from FxToggle).
  - Reads `Sonata.ViewOption.useContributions()`; returns `null` if empty.
  - Body: `<Stack gap="sm">` of one `<ViewOptionGroup contribution=… />` per
    contribution.
  - `ViewOptionGroup`: `const values = useConfig(c.config); const set =
    useSetConfig(c.config);` then map the chosen field keys
    (`c.fields ?? Object.keys(c.config.fields)`) to
    `<FieldRenderer field={c.config.fields[key]} value={values[key]}
    onChange={(v) => set(key, v)} />`, wrapped in a small labeled row.
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/piano-roll.tsx`
  Render `<ViewOptionsToggle />` right after `<FxToggle />` inside the HUD
  `Pin > Stack` (line ~552).
- `plugins/apps/plugins/sonata/plugins/piano-roll/web/index.ts`
  Add `Sonata.ViewOption({ id: "piano-roll", config: pianoRollConfig,
  fields: ["showNoteNames"] })` to contributions (import `pianoRollConfig` from
  `../shared/config`, `Sonata` already imported).

**Contributions — piano-keyboard**
- `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/index.ts`
  Add two contributions:
  ```ts
  Sonata.ViewOption({ id: "key-labels", config: pianoKeyboardConfig }),
  Sonata.ViewOption({ id: "key-style", config: keyboardStyleConfig }),
  ```
  Import `keyboardStyleConfig` from
  `@plugins/apps/plugins/sonata/plugins/primitives/keyboard/web`.

**Export descriptor — keyboard primitive**
- `plugins/apps/plugins/sonata/plugins/primitives/keyboard/web/index.ts`
  Add `export { keyboardStyleConfig } from "../shared/config";` (the barrel
  already re-exports `KeyStyle` from the same file — same precedent).

No server, schema, or migration changes. No new config registration (all three
descriptors already register via `ConfigV2.WebRegister`).

## Key existing code to reuse

- `plugins/apps/plugins/sonata/plugins/piano-roll/web/components/fx-toggle.tsx`
  — template for the chip (pointer guard, popover, ToggleChip styling,
  per-contribution row component for hook stability).
- `FieldRenderer` + `Fields.Renderer.Dispatch` —
  `plugins/config_v2/plugins/fields/web` (generic field control).
- `useConfig`/`useSetConfig` — `@plugins/config_v2/web`.
- `Sonata.Hud` in `shell/web/slots.ts` — precedent for a shell-owned,
  piano-roll-rendered slot.

## Boundary / convention checks

- Collection-consumer clean: the chip reads `Sonata.ViewOption` generically and
  never imports `pianoKeyboardConfig`/`keyboardStyleConfig`.
- `keyboard` primitive stays a leaf; `piano-keyboard` (not the primitive)
  surfaces `keyStyle`.
- Chip component lives in `web/components/` (per repo convention), not inline in
  the barrel.
- New chip is host-owned (rendered directly in `piano-roll.tsx`), matching
  `FxToggle` — it needs the HUD pointer-events guard, so it is not itself a
  `Sonata.Hud` contribution.

## Verification

1. `./equin build` (from this worktree). Expect a clean build +
   `./equin check` passing (notably `plugin-boundaries`,
   `plugins-doc-in-sync`, `type-check`).
2. Open `http://<worktree>.localhost:9000/sonata/song/<id>` with a song loaded.
3. Confirm a new chip (tune/sliders icon) sits beside the FX chip top-right.
4. Scripted Playwright check (`bun e2e/screenshot.mjs`):
   - Click the chip → popover opens with **Note names in bars** (switch),
     **Key labels** (enum), **Key style** (enum).
   - Toggle **Note names** → falling bars show/hide their note names live.
   - Change **Key style** flat↔realistic → the 88-key keyboard re-renders.
   - Change **Key labels** scope → keyboard key labels change.
   - Reload → choices persist (global config_v2).
5. Confirm the FX chip still works independently and the HUD pointer-events /
   drag-to-scrub still behave (a press on either chip opens its popover, does not
   scrub the lane).
