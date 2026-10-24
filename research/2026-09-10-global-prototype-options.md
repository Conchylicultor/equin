# Prototype options: declared in the page, picked by the app

## Context

Many prototypes let you flip between versions of their design: a colour
palette, a pane style, a marking style. An audit of all 16 prototypes (on
2026-09-10) found 6 that do this, and each built its own switcher:

| Prototype | What you can switch | Hand-built as |
| --- | --- | --- |
| equin landing `proto-1788797350-gqju` | theme (2), palette (5) | a second HTML file behind links, plus buttons saved in localStorage; two pills in the bottom corners |
| Mist panes `proto-1786877040-3k6f` | pane style (3) | a bottom-right pill with hand-drawn mini diagrams |
| Annotation cards `proto-1788084248-1l6f` | 8 settings | a fixed side panel inside the canvas, keys 1–5 |
| Control panel studies `proto-1787099864-wlwr` | 11 studies, 5 proposal switches, 12 separate "show rails" toggles | a left sidebar menu and per-study header buttons; study kept in `#hash` |
| Sketch roll `proto-1787083342-tbpa` | 2 choices, 1 on/off, 9 sliders | a toolbar across the canvas top |
| Control panel vocabulary `proto-1786965720-op2v` | show rails | a checkbox under the stage |

What that costs:

1. **Every agent designs a switcher**, and each one looks different.
2. **The switcher gets into the design.** It takes canvas space (the side panel,
   the toolbar), shows up in the gallery thumbnail and in screenshots, and the
   design's own CSS leaks into it (equin had to add `all: unset` and turn off
   `::before`/`::after` to undo its link styles).
3. **Every edit resets the choice.** Saving a file reloads the frame, so you are
   back on the default. Only equin's palette survived (localStorage); the
   studies' `#hash` is dropped because the reloaded `src` has none.
4. **The app can't see the options.** No link to "the Azure version", Compare
   can't show the picked variant, and "Improve this prototype" doesn't tell the
   agent which variant the user is looking at.

**Outcome:** a prototype *declares* its options in `<head>`, the way it declares
its title and viewport. The app draws the picker, **outside the prototype's
page**, as a small floating pill over the stage that expands on hover. The
picked value reaches the page as one attribute on `<html>`, so the page contains
no picker code and no picker styling. The choice survives edits, rides Present
and Compare, and is told to the Improve agent.

Owner decisions (2026-09-10):

- Picker: a floating menu that auto-opens on hover and expands to reveal the
  options.
- Option kinds in v1: **choices only** (on/off is just `off | on`). No number
  sliders.
- Migrate every existing prototype whose knobs fit.
- Keeping agents from building their own switchers is **instructions only**
  (`prototypes/CLAUDE.md` and the launch prompts). No check.

## The contract (what a prototype author writes)

```html
<html lang="en" data-palette="violet" data-pane="flush">
<head>
  <meta name="prototype-option" content="palette: violet | indigo | azure | ice | navy" />
  <meta name="prototype-option" content="pane: flush | floating | soft-tray" />
```

- **One `<meta name="prototype-option">` per option**, written as
  `<name>: <value> | <value> | …`. Order of the tags = order in the picker;
  order of the values = order of the choices.
- **The default is the attribute the author puts on `<html>`**:
  `data-<name>="<value>"`. So the page has the attribute in every context:
  double-clicked off disk, in the thumbnail render, and in the app. CSS can
  target any value including the default (`:root[data-palette="violet"]`), and
  JS never reads `undefined` (`document.documentElement.dataset.palette`).
- **The app overwrites that attribute** with the picked value. Nothing else in
  the page changes.
- Names: `[a-z][a-z0-9-]*`; `v` is reserved (the cache-bust). Values:
  `[a-z0-9][a-z0-9-]*`. At least 2 distinct values. Labels in the picker are
  the tokens humanized (`soft-tray` → "Soft tray", `88-keys` → "88 keys"), so
  authors pick readable tokens.
- **Switching reloads the frame.** Options are read once, at load. So a
  CSS-only prototype and a React one behave the same, and an author never has to
  listen for changes. The price is that in-page state (typed text, scroll)
  resets on a switch, as it already does on every edit.

Problems, reported on the gallery card and the Focus banner like the malformed
`mocks` tag: a tag that doesn't parse (with the reason), a duplicate option
name, the reserved name `v`, fewer than 2 values, a duplicate value, a missing
default attribute on `<html>` ("add `data-palette="violet"` to `<html>`"), or a
default that isn't one of the values. A malformed option is left out of the
picker. The problem line says why.

## Design

### 1. `files/core/options.ts`: parse, resolve, encode (pure, tested)

Next to `files/core/mocks.ts`, and following its shape.

```ts
export interface PrototypeOption {
  name: string;
  values: readonly [string, string, ...string[]];
  /** The value the page's own <html data-<name>> carries. */
  default: string;
}

export type OptionDeclaration =
  | { kind: "declared"; name: string; values: readonly [string, string, ...string[]] }
  | { kind: "malformed"; raw: string; reason: string };

/** Picked values that DIFFER from their option's default, keyed by option name. */
export type OptionPicks = Readonly<Record<string, string>>;

export function parseOptionDeclaration(raw: string): OptionDeclaration;
/** Declarations + <html> defaults → valid options, and one problem detail per line that is not one. */
export function foldOptions(source: OptionSource): { options: PrototypeOption[]; problems: string[] };
/** Stored picks → picks valid against today's declaration (drops unknown names/values and defaults). */
export function resolvePicks(options: readonly PrototypeOption[], stored: Record<string, string>): OptionPicks;
/** Query → picks, for the server. Fails (never drops) on an undeclared name or value. */
export function picksFromQuery(
  options: readonly PrototypeOption[],
  search: URLSearchParams,
): { ok: true; picks: OptionPicks } | { ok: false; reason: string };
export function humanizeToken(token: string): string;
```

- `prototypeUrl(name, { v, picks })` in `files/core/prototypes.ts` gains
  `picks`, appended as `?<name>=<value>` in declaration order after `v`.
  Defaults are never written, so an untouched prototype keeps today's URL.
- `PrototypeMetaSchema` gains `options: z.array(PrototypeOptionSchema)` (valid
  options only), with a `satisfies ZodParser<PrototypeOption>` guard like
  `MocksDeclarationSchema`.
- `resolvePicks` *dropping* a stale stored pick is correct, not a swallowed
  failure. It is a remembered preference for a value the author has since
  removed. `picksFromQuery` *fails* instead, because a URL naming a value that
  doesn't exist is a broken link and has to say so.

### 2. `files/shared/list-metas.ts` + `files/core/validate.ts`: read the declaration

- `parseHtmlMeta` adds two handlers to its existing `HTMLRewriter`:
  `.on("html")` collects `data-*` attributes (`readHtmlAttr` from
  `@plugins/infra/plugins/html-decode/core`), and `.on("meta")` collects every
  `name="prototype-option"` content in order. It then folds them into
  `PrototypeOption[]`. The first-wins `??=` rule does not apply here: options
  are a list.
- `validatePrototypeFolder` pushes one `problems[]` entry per problem listed
  above, reusing the parse (no fourth hand-written rewriter pass). The
  declaration read is one helper, `readPrototypeOptions(html)` in
  `files/core/option-source.ts` (core, because `validate.ts` lives there and
  already runs HTMLRewriter), shared by the list, the validator and the server.

### 3. Server: stamp the picked values onto `<html>`

`handlePrototypeAsset` in `files/server/internal/handlers.ts`:

- Only for `index.html`, and only when the query carries anything besides `v`.
  Otherwise the file streams through untouched, as today.
- Read the file text, run `readOptionDeclarations`, then `picksFromQuery`.
  `{ok:false}` → `400` plain text naming the option and the declared values.
  It renders inside the frame, so a broken link is visible.
- `{ok:true}` → a `new HTMLRewriter().on("html", el => el.setAttribute("data-" + name, value))`
  over the text, returned with the same `content-type` and `no-store`.
- The file is buffered first because `<html>` streams before the `<meta>` tags
  that say what's valid. Prototype HTML files are small.
- This is the first HTMLRewriter *rewrite* in the repo. Every existing use only
  extracts. Say so in the files `CLAUDE.md`.

Thumbnails need no change. They render `file://` off disk, so they show the
authored defaults, which is the right cover.

### 4. Gallery: one source for the frame URL, and the picks state

- **State.** `PrototypeDetailProvider` (`gallery/web/context.tsx`) gains the
  stored picks, via `useDraft("prototype-options", {}, { scope: name })` from
  `@plugins/primitives/plugins/persistent-draft/web`. It is remembered per
  prototype on this device, across navigation and reloads. The context exposes
  `storedPicks` and `setPick(name, value)`.
  - It is not in the pane URL: the pane primitive has no query state, and a
    route param per option would be a different design.
  - The shareable link to a variant is Present → New browser tab (see below).
- **One URL builder.** New hook `usePrototypeSrc(meta, version)` in gallery web
  = `prototypeUrl(meta.name, { v: version, picks: resolvePicks(meta.options, storedPicks) })`.
- **Stages receive the URL, not its parts.** `PrototypeStageProps` replaces
  `version` with `src`: the prototype document URL, built once in `StageBody`
  with that hook. A stage can no longer build a frame that forgets the picks,
  and there is one less place to spell out `?v=`. Follow-through:
  - `ScaledIframe` takes `src` instead of `version`.
  - Compare's `MockFrame` takes `src`.
  - `CounterpartKindProps.version` is deleted. No kind reads it; the route kind
    deliberately does not cache-bust.
  - Present's overlay and New-browser-tab item call `usePrototypeSrc`. They
    render inside the provider, under the pane's Actions. So "New browser tab"
    opens `…/index.html?v=…&palette=azure`: a real link to that variant.

### 5. The picker: a floating pill that expands on hover

`gallery/web/components/options-picker.tsx`, rendered by `StageBody` over the
stage and **only when `meta.options` is non-empty**. It is pane-level, so it
serves Focus and Compare alike.

- Built on `FloatingAction` + `FloatingActionFadeIn` from
  `@plugins/primitives/plugins/overlay/plugins/floating-action/web`. It opens on
  hover, focus or tap, closes after a short grace delay, closes on Esc and on a
  click outside, and uses a stable hover box so it doesn't flicker. This is the
  same primitive the global action bar uses.
- Pinned to the **bottom-right corner of the stage area** (the css skill's
  `Pin`, as the global action bar pins its own). It lives in the app's DOM, not
  in the iframe: it is not in the prototype's screenshots or thumbnail, and the
  prototype's CSS can't reach it. In Compare that corner is over the real app's
  half, not the mock.
- **Collapsed:** a tune icon plus the current value of each option, e.g.
  "Azure · Soft tray". It tells you what you're looking at without opening.
- **Expanded** (upward: `anchor="bottom-right"`, `direction="col"`,
  `triggerAt="end"`): one row per option, with its label and a **wrapping row of
  single-select chips** (the toggle-chip primitive, `ToggleChip` /
  `SegmentedControl` from `@plugins/primitives/plugins/css/plugins/toggle-chip/web`,
  whichever wraps). Plus "Reset to defaults" when anything differs.
  - No dropdown `Select`: its menu renders in a portal outside the hover box, so
    moving the pointer into it would close the panel under it. Wrapping chips
    cover the 11-study case without that.
- Picking a value calls `setPick`. The frame's `src` changes and it reloads on
  the new value.

### 6. The Improve prompt and the New-prototype prompt

- `improveText` (`gallery/web/components/detail-actions.tsx`): when any pick
  differs from the default, add one line, e.g. "The user is looking at it with
  these options picked: palette = azure, pane = soft-tray." `ImproveButton`
  resolves the picks against the meta from `prototypesResource`.
- Both prompts (`improveText` and `newPrototypeText` in
  `prototype-gallery.tsx`) gain one rule: "Variants the user flips between are
  declared options (`prototypes/CLAUDE.md` § Options). Never draw a switcher
  inside the page."

### 7. Docs

- `prototypes/CLAUDE.md`: a fifth metadata tag, and a new **Options** section
  with the contract above. It states the rule: **never build a switcher, toggle
  bar or settings panel into the page for flipping between variants. Declare
  options and the app draws the picker.** It also states that a control that is
  part of the design (a product's own dropdown) is not an option.
- `prototypes/_template/index.html` (repo) and
  `~/.singularity/apps/prototypes/_template/index.html` (host-global,
  never-overwrite seed): a commented-out example `prototype-option` tag and a
  matching commented `data-*` on `<html>`, next to the `mocks` example.
- `CLAUDE.md` prose for `files` (the declaration, the stamping rewrite) and
  `gallery` (picks state, `usePrototypeSrc`, the picker). The plugin
  descriptions for `files` and `gallery` change too.

## Migration (host-global hand edits, not in git)

Each prototype keeps its look. Only the switcher chrome goes, and whatever the
design keyed on becomes `:root[data-<name>="…"]` / a `dataset` read at load.
Each migrated prototype is checked with a before/after screenshot for every
value.

| Prototype | Options | Notes |
| --- | --- | --- |
| equin `gqju` | `theme: editorial \| launch`, `palette: violet \| indigo \| azure \| ice \| navy` | Fold `dark-launch.html` into `index.html`: both bodies in one file, each stylesheet scoped under its theme (`:root[data-theme="editorial"]` / `…"launch"`), the other body hidden. Delete both pills, the localStorage script and the narrow-screen rule. Palette only affects Launch, and v1 can't say so (no descriptions). |
| Mist panes `3k6f` | `pane: flush \| floating \| soft-tray` | Delete `PaneSwitch`, `PaneMini` and the `.pane-switch`/`.pm` CSS. `App` reads `dataset.pane` once. Update the description, which mentions the "bottom-right switcher". |
| Annotation cards `1l6f` | `launch: corner \| morph \| chip \| gutter \| handle`, `marking: wash \| rule \| gutter \| frame \| underline \| latent`, `labels`, `icons`, `color`, `density`, `reveal: off \| on`, `guides: off \| on` | Delete the side panel and keys 1–5. The page gets the full canvas. The per-choice "why" lines are lost (v1 has no descriptions); keep them as an HTML comment. |
| Control panel vocabulary `op2v` | `rails: off \| on` | Delete the checkbox. The React `rails` state becomes a `dataset` read. |
| Control panel studies `wlwr` | `study:` the 11 study ids, `grid: off \| on`, `footer: lead \| none \| trail \| opt-out`, `width: roles \| adaptive \| frozen \| bounds`, `bleed: rail \| content \| panel` | Delete the left study menu, the proposals panel and the `#hash` code; the canvas shrinks by the menu's 226px (1900 → 1674) so every study sits where it did. **Changed from the first draft:** the in-study "show rails" checkboxes (6, not 12 — two default ON) stay in their studies' headers, beside the other controls each study owns, so they are not an option. |
| Sketch roll `tbpa` | `keys: 3-octaves \| 88-keys`, `stage: paper \| dark`, `boil: off \| on` | Only those three leave the toolbar. Play/pause and the 9 sliders stay (v1 has no sliders). |

Not migrated: the 3 Improve mocks and the Zone DAG explorer. Their controls are
the design itself.

**Verified (2026-09-10):** every migrated variant that could be driven through
the old switcher was screenshotted old (backup, via its own switcher) vs new
(served with the picks) and pixel-diffed — 15 variants across equin, Mist
panes, Annotation cards, Control panel vocabulary and Control panel studies,
all 0.000% different (Annotation cards and the studies compared over the
design area, since the removed panel/menu no longer takes width). Sketch roll
is animated, so it was checked by eye in both states.

## Step order

1. `files/core/options.ts` + `options.test.ts` (next to the source): parse,
   humanize, resolve, query round-trip, every problem reason.
2. Schema `options` field, `readOptionDeclarations`, `list-metas.ts`,
   `validate.ts` problems.
3. Server stamping in `handlePrototypeAsset`.
4. `usePrototypeSrc`, the stored picks in the provider, and `src` replacing
   `version` through `PrototypeStageProps`, `ScaledIframe`, `MockFrame`,
   `CounterpartKindProps`, Present.
5. The floating picker.
6. Prompts, docs, the two templates.
7. Migrate the six prototypes, one at a time, with screenshots.

## Verification

```bash
./equin test plugins/apps/plugins/prototypes/plugins/files
./equin build        # run_in_background: true, then end the turn
```

- **Server:** `curl` `http://<this deploy>/api/prototypes/proto-1788797350-gqju/index.html?palette=azure`
  → `<html … data-palette="azure">`. `?palette=nope` → 400 naming the values.
  No query → byte-identical to the file on disk.
- **End to end:** a new script
  `plugins/apps/plugins/prototypes/plugins/gallery/e2e/options-picker.ts`.
  1. Open the equin detail pane and hover the pill.
  2. Pick Azure, then assert the iframe's `documentElement.dataset.palette === "azure"`.
  3. Rewrite the prototype's `index.html` with its own bytes (the watcher bumps
     the version and the frame reloads). Assert the value is still Azure.
  4. Switch to Compare and assert the mock half is Azure too.
  5. Open the Improve popover and assert the prompt names `palette = azure`.
- **Screenshots** (`e2e-harness/e2e/screenshot.ts`): the collapsed pill, and the
  expanded panel on a prototype with 8 options (Annotation cards).
- **Double-click still works:** the gallery thumbnails of all six migrated
  prototypes re-render as ready (they load `file://`, so they prove the page
  renders with its authored defaults). Open each `index.html` off disk once as
  well.
- `./equin check` (type-check, `prototypes:self-contained`, docs in sync).
