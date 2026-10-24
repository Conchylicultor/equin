# Sonata: one Look switch, not two overlapping ones

## Context

Sonata's View popover currently asks the user to set two controls that both decide
how the piano keys are drawn:

- **Key style** — Flat (Synthesia) / Realistic — owned by the keyboard primitive
  (`primitives/plugins/keyboard/shared/config.ts`), surfaced as a `ViewOption` by
  `piano-keyboard`.
- **Look** — Digital / Sketch — owned by `sonata/plugins/look`, added by the
  sketch-look work (`research/2026-08-18-sonata-sketch-look.md`).

They overlap. `keyboard.tsx:308-309` reads the look first and, when its palette says
`keys.drawn`, never consults `keyStyle` at all — so under Sketch the Key style row
sits in the popover doing nothing. Even under Digital the user is asked to reason
about two axes when they expect one choice of how the app looks.

The sketch-look doc named exactly this and deferred it ("Graying out the now-inert
Key style row … Cross-config coupling isn't something the `Sonata.ViewOption` slot
shape supports"). That framing accepted two axes and looked for a way to hide one
row. The user's expectation is simpler: **one theme option for the app.**

Decisions taken with the user:

- **One list of three looks.** `keyboardStyleConfig` is deleted; the look is the
  only switch.
- **Label stays "Look."** "Theme" would collide with the app-wide light/dark +
  tweakcn customizer, and the roll is deliberately theme-independent.
- **Sketch keys stay unreachable in flat/realistic form** — no fourth look.

## The shape of the solution

Today's four combinations are already only three reachable ones
(`digital×flat`, `digital×realistic`, `sketch×drawn`; `sketch×realistic` has no
spelling). So the two axes were never independent — they were one axis with three
values, wearing two controls. Naming that directly is the whole change:

```
SONATA_LOOKS = [ flat | realistic | sketch ]
```

This is the **rung-1 fix** on the `CLAUDE.md` ladder — the wrong thing loses its
spelling, rather than gaining a predicate that hides it. It also removes the reason
to touch `Sonata.ViewOption` at all: with one row there is nothing to declare
irrelevant. See "The slot gap" below for why we are deliberately *not* adding
`disabledWhen`.

**A look is a preset over two internal dimensions, not a flat copy.** `flat` and
`realistic` share every roll surface (lane, grain, pen, grid, labels) and differ
only in the key skin. Spelling both entries out longhand would mean a future tweak
to the digital lane has to be made twice. So `styles.ts` keeps one private
`DIGITAL_ROLL` base that both spread, and `Record<SonataLook, SonataLookStyle>`
still makes a fourth look a tsc error until it answers for every surface.

**The key palette becomes a discriminated union.** Today `keys` is
`{ drawn: boolean; ivory; ebony; ink; shade }`, and the four colours are dead
values under `digital`. With three looks that dead block would be written twice.
Instead the drawn palette exists only on the arm that draws:

```ts
export type SonataDrawnKeys = {
  skin: "drawn";
  ivory: string; ebony: string; ink: string; shade: number;
};
export type SonataKeys = { skin: "flat" } | { skin: "realistic" } | SonataDrawnKeys;
```

`SketchKeys` then takes `palette: SonataDrawnKeys` instead of
`SonataLookStyle["keys"]`, so it cannot be handed a palette that has no colours.

### Migration: none needed

Checked before choosing the value ids. Every persisted `keyStyle` across every
worktree's user layer (`~/.singularity/config/*/apps/sonata/primitives/keyboard/config.jsonc`)
is `"flat"` — nobody has ever selected Realistic. And `flat` is the new default
look. So deleting the descriptor resets nothing, and no data migration is written.
The `look` value id changes `digital` → `flat`; the only persisted `look` override
anywhere is in an unrelated worktree, and `sketch` keeps its id.

## Files to change

### 1. `plugins/apps/plugins/sonata/plugins/look/core/config.ts`

- `SONATA_LOOKS` → three entries, in picker order:
  `{ value: "flat", label: "Flat (Synthesia)" }`, `{ value: "realistic", label: "Realistic" }`,
  `{ value: "sketch", label: "Sketch" }`.
- Export `SONATA_DEFAULT_LOOK = "flat"` and use it as the `enumField` default, so
  the default look has one spelling (see §5 — `grid.ts` / `labels.ts` need it too).
- The field keeps `label: "Look"`. Widen the description: it now covers the keys as
  a first-class part of the choice, not a consequence of it.
- Rewrite the block comment. The current one explains why `digital` is not called
  `synthesia` ("'Flat (Synthesia)' already uses that word one level down, for a
  different axis") — there is no longer a level down and no other axis. Replace it
  with why there is one axis: three reachable combinations, one control.
- `asSonataLook` is unchanged.

### 2. `plugins/apps/plugins/sonata/plugins/look/core/styles.ts`

- Add `SonataKeys` / `SonataDrawnKeys` as above; `SonataLookStyle.keys: SonataKeys`.
- Extract a private `const DIGITAL_ROLL: Omit<SonataLookStyle, "keys">` holding
  today's `digital` lane / grain / pen / grid / labels **verbatim**, and build:
  ```ts
  flat:      { ...DIGITAL_ROLL, keys: { skin: "flat" } },
  realistic: { ...DIGITAL_ROLL, keys: { skin: "realistic" } },
  sketch:    { …today's sketch roll…, keys: { skin: "drawn", ivory, ebony, ink, shade } },
  ```
  The four colour literals currently sitting unread on `digital.keys` are deleted,
  not copied — the union has nowhere to put them.
- Update the `keys` docstring: it no longer describes a `drawn` flag overriding a
  second config, it describes which skin this look wears.

### 3. `plugins/apps/plugins/sonata/plugins/look/core/index.ts`

Export `SONATA_DEFAULT_LOOK`, `SonataKeys`, `SonataDrawnKeys` alongside the existing
surface.

### 4. `plugins/apps/plugins/sonata/plugins/primitives/plugins/keyboard/`

- **Delete `shared/config.ts`** (`keyboardStyleConfig`, `KeyStyle`).
- **Delete `server/index.ts`** — its own comment says it "exists solely to register
  the keyboard's style config". With the descriptor gone the runtime has no reason
  to exist; the plugin becomes web+core only. `./equin build` regenerates
  `server.generated.ts`.
- `web/index.ts` — drop the `ConfigV2.WebRegister` contribution (leaving
  `contributions: []`), the `keyboardStyleConfig` re-export, and the `KeyStyle` type
  export. Nothing outside this plugin imports either (verified: only its own
  autogenerated `CLAUDE.md` block mentions `KeyStyle`).
- `web/internal/keyboard.tsx`:
  - One config read instead of two — `useConfig(sonataLookConfig)` only.
  - `const style = SONATA_LOOK_STYLES[asSonataLook(look)].keys.skin;` The local
    `type KeySkin = KeyStyle | "drawn"` is deleted in favour of `SonataKeys["skin"]`,
    which is now the same three-member union from one place.
  - `feltStyle` widens to the skin union. It is only called inside the existing
    `{style !== "drawn" && …}` guard, so TS narrows it at the call site — no new
    branch.
  - Both `<SketchKeys palette={…}>` call sites pass the narrowed drawn arm. The
    cleanest form is to narrow once: `const keys = …keys; … {keys.skin === "drawn" && <SketchKeys palette={keys} …/>}`
    so the union does the proving rather than a cast.
  - Rewrite the "THREE skins" header comment: all three now come from one switch,
    so the paragraph about a "DIFFERENT switch" that "takes precedence" and about
    `KeySkin` being local so "the config keeps its two options and its store path"
    is describing a design that no longer exists.
- `web/internal/sketch-skin.tsx` — `palette: SonataDrawnKeys` (line ~196).

### 5. `plugins/apps/plugins/sonata/plugins/piano-roll/web/internal/pixi/`

`grid.ts:87` and `labels.ts:274` seed their pre-`setLook` ink from
`SONATA_LOOK_STYLES.digital.{grid,labels}`. That key no longer exists →
`SONATA_LOOK_STYLES[SONATA_DEFAULT_LOOK].{grid,labels}`, which is also more honest
about what that value is (the default look's ink, held until `setLook` runs).

Nothing else in the piano roll changes: `piano-roll.tsx`, `scene.ts` and
`note-mesh.ts` all index the table by the config value and read whole sub-objects,
so a third key is transparent to them.

### 6. `plugins/apps/plugins/sonata/plugins/piano-keyboard/web/index.ts`

Remove the `key-style` `ViewOption` contribution and the `keyboardStyleConfig`
import. Trim the comment above the remaining `key-labels` option — it currently
explains why *both* keyboard-primitive prefs are surfaced from here; only
`key-labels` is left, and it belongs to this plugin's own config, not the leaf's.

### 7. `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts`

The `ViewOption` slot's comment uses key-style as its running example twice
("note names, key labels, key style, …" and "e.g. key-style inside Notation").
Swap in options that still exist (`look`, `key-labels`). **The slot signature is
unchanged** — see below.

### 8. Config origin file

Delete `config/apps/sonata/primitives/keyboard/config.origin.jsonc`. The
`config-origins-in-sync` check enforces the origin tree against the registered
descriptor set, and `./equin build` regenerates
`config/apps/sonata/look/config.origin.jsonc` with the new three-value comment and
default.

### 9. Prose

- `look/CLAUDE.md` — rewrite. The current text is built around "one switch drives
  all four surfaces … under `sketch` the keyboard's own Flat/Realistic config stops
  being read (it keeps its store path, so no persisted preference resets)". That
  whole paragraph, and the "the keyboard owning it would make its keys-scoped config
  a lie" argument, describe the two-config world. The neutral-leaf ownership
  argument still holds and should stay: the keyboard primitive and the roll both
  read the look, and neither can own it without importing the other.
- `primitives/keyboard/CLAUDE.md:18` — the `SONATA_LOOK_STYLES[look].keys.drawn`
  precedence sentence goes; the keyboard now reads one config, full stop.
- `look/e2e/look-verify.ts` — the docstring's worked example says "switch Look →
  Sketch"; still correct, but the surrounding digital/sketch wording should say
  flat/sketch.
- Autogenerated blocks in every touched `CLAUDE.md` regenerate on build
  (`plugins-doc-in-sync`).

## The slot gap — deliberately not closed

`Sonata.ViewOption` carries `{ id, displays, config, fields }` and has no way for a
row to say it is irrelevant. That is real, and after this change it has **no
consumer**. The six contributions are `piano-roll/showNoteNames`,
`notation/{staffLayout,showChordSymbols}`, `chord-label/mode`,
`piano-keyboard/key-labels` and `look` — `key-style` was the only row that ever went
inert under another config's value, and this change deletes it rather than hiding it.

Exploration confirms nothing like it exists anywhere yet: neither `FieldDef`/
`FieldMeta` (`plugins/fields/core/internal/field-spec.ts`) nor `ConfigDescriptor`
(`plugins/config_v2/core/internal/types.ts`) carries any relevance concept, and the
config settings pane renders every field of a descriptor unconditionally. The only
"declare relevance as a predicate" precedent in the repo is `defineShortcut({ when })`,
an unrelated domain.

Adding an optional `relevant?: (values) => boolean` now would ship an API with zero
call sites — nothing keeps it honest, and it would sit one rung *below* the fix we
are making (a runtime predicate hiding a row that still exists, vs. the row not
existing). If a second case ever appears, the right shape is a predicate over the
*whole* config surface evaluated in `ViewOptionGroup`, and it should be designed
against two real consumers, not one hypothetical. Worth an `add_task` note rather
than code.

## Verification

1. `./equin build` (background — see `CLAUDE.md`), then open
   `http://att-1787158306-hraq.localhost:9000/sonata` and a song.
2. Open the View popover (the `MdTune` chip). **There is exactly one appearance
   row, "Look", with three options** — Flat (Synthesia), Realistic, Sketch — and no
   "Key style" row in any of them.
3. Flat → Realistic: keys gain gradients, bevels, the pressed depression and the
   black-key front face; the lane, grid and falling notes are unchanged. Flat is
   pixel-identical to today's default.
4. → Sketch: cream lane, graphite rules, inked notes, hand-drawn keys — unchanged
   from today's Sketch. Toggle light/dark while Sketch is active: the roll must stay
   paper (`refreshColors()` re-resolves stored ink).
5. Play a glissando under Sketch: `data-pitch` hit-testing must still work (the
   drawn skin is a `pointer-events-none` layer under the key divs).
6. Check the readout chips (chord/key) below the roll follow the same choice, and
   that the website's Sonata vignette (`apps/website/…/app-gallery`) still renders —
   it embeds the real keyboard, which now reads only the look.
7. `./equin test plugins/apps/plugins/sonata` — `sketch-paths.test.ts`,
   `labels.test.ts`, `geometry.test.ts`, `css-color.test.ts` cover pure functions
   this change does not touch and must pass unmodified.
8. `./equin check` — in particular `config-v2:registrations-paired` (the
   deleted descriptor must be gone from *both* runtimes), `config-origins-in-sync`
   (the deleted origin file), `plugins-registry-in-sync` (the keyboard primitive's
   server runtime disappearing) and `plugins-doc-in-sync`.
9. Settings → Config: the keyboard style entry is gone; `apps/sonata/look` lists
   three values.
10. Optional visual pair:
    `bun plugins/apps/plugins/sonata/plugins/look/e2e/look-verify.ts --out /tmp/flat`,
    switch to Sketch in the app, re-run with `--out /tmp/sketch`.
