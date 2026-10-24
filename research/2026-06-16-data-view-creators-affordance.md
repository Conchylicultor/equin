# data-view `creators` — a first-class create affordance

## Context

Three gallery surfaces — the **Home app launcher**, the **Story gallery**, and the
**Sonata library** — already share the `data-view` primitive (gallery view). What
they *don't* share is the "+/add a thing" affordance: each hand-rolls its own, and
all three are inconsistent or broken:

- **Home** (`app-grid.tsx`) passes `actions={<IconButton MdAdd onClick={() => {}}/>}` — a
  **dead no-op**. Its CLAUDE.md promises a trailing dashed "+" launcher card that was never built.
- **Story** (`story-gallery.tsx`) renders its **own header bar** *outside* the DataView
  (a `<Text>` title + a `<Button>New story</Button>`), duplicating chrome the primitive
  already provides.
- **Sonata** (`song-library.tsx`) threads per-source add buttons through the `actions`
  slot via a bespoke `Library.Source.AddAction` component slot (MIDI import + chord-grid).

The only built-in create affordance in `data-view` today is `HierarchyConfig.onCreate`
(tree-only, parent-scoped). Flat views (gallery/table/list) have nothing, so everyone
reinvents it on the free-form `actions` slot.

**Goal:** lift "create" into `data-view` as a typed, first-class concept — one
declaration that renders consistently as a toolbar affordance (1 → button, N → menu),
an opt-in trailing gallery card, and an empty-state CTA. Migrate all three surfaces onto
it, deleting their ad-hoc paths. The primitive stays domain-pure; where the creator list
comes from (a literal vs. a slot collection) stays the consumer's choice.

This is load-bearing primitive design — favor the clean abstraction.

## Decisions (confirmed)

- **Placement:** toolbar affordance on every view **plus** an opt-in trailing dashed "+"
  card in the gallery grid, enabled only for **single-creator** surfaces (Home, Story).
  Sonata's multi-source case stays toolbar-menu only.
- **Home:** migrate to `creators` now with a **documented TODO no-op** `onSelect` (no
  create-app feature exists yet) — matching the existing dead button and the CLAUDE.md promise.
- **Tree `HierarchyConfig.onCreate` stays as-is** — it's a parent-scoped child-add, a
  different affordance. Not merged here. (Future: the tree's *root* add could derive from
  `creators`; out of scope.)

## The abstraction

A new domain-agnostic type in `data-view` core:

```ts
export interface CreateOption {
  id: string;
  label: string;          // "New story", "Import MIDI"
  icon?: ReactNode;       // already-sized icon element (matches CoverContent convention)
  description?: string;   // shown in the N-menu only
  onSelect: () => void | Promise<unknown>;
}
```

Non-generic (a creator makes a *new* row; nothing to parametrize on `TRow`) — deliberately
unlike `HierarchyConfig<TRow>`/`SelectionConfig`. New prop on `DataViewProps<TRow>`:

```ts
/** Typed create affordances. Host renders them in the toolbar (1 → Button,
 *  N → "+" menu) and threads them to views (trailing card + empty CTA). */
creators?: CreateOption[];
```

Also threaded into `DataViewRenderProps` so views can opt into a trailing card / CTA.

### Host rendering (the toolbar)

New host-internal component `web/components/creators-control.tsx`:

- `0` → renders nothing.
- `1` → `<Button size="sm" onClick={run(c)}>{c.icon}{c.label}</Button>`.
- `N` → an `IconButton MdAdd` trigger opening a shadcn **`DropdownMenu`** (already exported
  from `@plugins/primitives/plugins/ui-kit/web`); each `DropdownMenuItem` shows `icon + label`
  with `description` as a muted sub-line.
- Owns an in-flight **busy** state: `run(c)` sets busy, `await c.onSelect()`, clears in
  `finally`, disables the control while pending. This restores (host-side, for everyone)
  the per-button "Importing…" state Sonata hand-rolls today.

Placement in `data-view.tsx`'s toolbar: **immediately before `<ViewSwitcher>`**, after
`{actions}` — creators are the primary action; view controls like Sonata's sort
`SegmentedControl` stay in `{actions}` to its left. Also render it in the no-active-view
early-return branch so a creators-only/empty surface still shows it.

`DropdownMenu` lives in ui-kit, which data-view already imports (`cn`, `Button`) — no new
boundary edge. `popover`/`row` not needed. `creators-control.tsx` is **host-internal**:
not exported from the web barrel (consumers never render it).

### Gallery: trailing card + empty CTA

- Add `showCreateCard?: boolean` to `GalleryViewOptions` (`gallery/core/internal/types.ts`).
  When `options.showCreateCard && props.creators?.length === 1`, render a trailing dashed
  "+" card (dashed border + centered `MdAdd` + label) after the row map, firing the single
  creator's `onSelect`. Multiple creators → omit the card (rely on the toolbar menu);
  document this. Gate outer padding on `!props.embedded` like the rest of the grid.
- **Empty state:** keep `emptyState?: ReactNode` meaning "the words". In the gallery's
  `rows.length === 0` branch (which already sits *after* the `props.loading` guard, so the
  loading-vs-confirmed-empty distinction is preserved), render `emptyState` followed by a
  minimal creators CTA — `props.creators?.map(c => <Button onClick={run(c)}>{c.icon}{c.label}</Button>)`.
  Empty-state CTAs are low-traffic, so a plain stacked-button list is fine and avoids
  importing the host `CreatorsControl` into the gallery child (the gallery imports only the
  `CreateOption` *type*, which is type-only and allowed).

## Per-surface migration

### Story — literal, delete custom header
`plugins/apps/plugins/story/plugins/shell/web/components/story-gallery.tsx`
- Delete the custom header `<div>` (title + `<Button>New story</Button>`).
- Pass `title="Stories"` and
  `creators={[{ id: "story", label: "New story", icon: <MdAdd className="size-4"/>, onSelect: newStory }]}`.
- Add `viewOptions.gallery.showCreateCard: true` (single creator → trailing card).
- Replace the outer `all.pending` → `<Loading/>` gate by passing `loading` into DataView so
  the toolbar + creator stay visible during load (consistent with Sonata's pattern).

### Home — literal, documented stub
`plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx`
- Replace the dead `actions={<IconButton…/>}` with
  `creators={[{ id: "new-app", label: "New app", icon: <MdAdd className="size-4"/>, onSelect: () => {/* TODO: no create-app flow exists yet — stub */} }]}`.
- Add `viewOptions.gallery.showCreateCard: true` to restore the promised launcher placeholder.

### Sonata — slot → CreateOption (the one real refactor)
The motivating multi-source case. Today `Library.Source.AddAction?: ComponentType` is a
hook-using component (MIDI renders a hidden `<input type=file>`, both use `useOpenSong`).
Convert the slot to contribute **data**, with fully-imperative `onSelect` — the only blocker
is the `useOpenSong` hook, and everything else is already imperative (`fetchEndpoint`,
`uploadAttachment`, pure meta derivation).

- `plugins/apps/plugins/sonata/plugins/library/web/slots.ts` — `Library.Source`: replace
  `AddAction?: ComponentType` with `createOption?: CreateOption` (imported from data-view core);
  update the doc-comment.
- **New** `plugins/apps/plugins/sonata/plugins/library/web/open-song.ts` —
  `openSongImperative(song)` using the pane primitive's **imperative `openPane`** (already
  exported, targets the live store) + `sonataPlayerPane`. Export from the library web barrel.
  Keep `useOpenSong` (gallery cards still use it inside a component — context store is correct there).
- MIDI `…/sources/plugins/midi/web/components/midi-add-action.tsx` → `midi-create-option.ts`:
  export `midiCreateOption: CreateOption`. Imperative file pick via a tiny
  `pickFile(".mid,.midi", cb)` helper (`document.createElement("input")` + `.click()`), then
  `deriveMidiSongMeta` → `uploadAttachment` → `fetchEndpoint(createMidiSong, …)` → `openSongImperative`.
  Its `web/index.ts` contributes `createOption: midiCreateOption`.
- chord-grid `…/chord-grid/web/components/chord-grid-add-action.tsx` → `chord-grid-create-option.ts`:
  export `chordGridCreateOption: CreateOption` (compile starter → `fetchEndpoint(createChordGridSong)` →
  `openSongImperative`). Its `web/index.ts` contributes `createOption: chordGridCreateOption`.
- `song-library.tsx` — drop `sources.map(AddAction)` from `actions`; add
  `creators={sources.map(s => s.createOption).filter((c): c is CreateOption => !!c)}`. Keep the
  sort `SegmentedControl` in `actions`. No trailing card (N creators).

SongLibrary still never names MIDI — it maps an opaque `s.createOption`. The slot-shape change
is the contract; both sources move in lockstep.

## File change list

| File | Change |
|---|---|
| `…/data-view/core/internal/types.ts` | Add `CreateOption`; add `creators?` to `DataViewProps` + `DataViewRenderProps`. |
| `…/data-view/core/index.ts` | Re-export `CreateOption`. |
| `…/data-view/web/index.ts` | Re-export `CreateOption` (from `../core`). |
| `…/data-view/web/components/creators-control.tsx` | **New.** 0/1/N rendering (`Button` / `DropdownMenu`+`IconButton MdAdd`); host busy state. |
| `…/data-view/web/components/data-view.tsx` | Destructure `creators`; render `<CreatorsControl>` before `<ViewSwitcher>` (+ no-active-view branch); add `creators` to `renderProps`. |
| `…/data-view/plugins/gallery/core/internal/types.ts` | Add `showCreateCard?: boolean` to `GalleryViewOptions`. |
| `…/data-view/plugins/gallery/web/components/gallery-view.tsx` | Empty branch: `emptyState` + creators CTA; trailing dashed "+" card when `showCreateCard` && exactly 1 creator. |
| `…/story/plugins/shell/web/components/story-gallery.tsx` | Delete custom header; `title="Stories"` + literal `creators` + `showCreateCard`; pass `loading` to DataView. |
| `…/home/plugins/app-cards/web/components/app-grid.tsx` | Replace dead `actions` with stub `creators` + `showCreateCard`. |
| `…/sonata/plugins/library/web/slots.ts` | `AddAction?: ComponentType` → `createOption?: CreateOption`. |
| `…/sonata/plugins/library/web/open-song.ts` | **New.** `openSongImperative(song)` (imperative `openPane`). |
| `…/sonata/plugins/library/web/index.ts` | Export `openSongImperative` (keep `useOpenSong`). |
| `…/sonata/plugins/library/web/components/song-library.tsx` | `actions` drops AddActions; add `creators` from `createOption`. |
| `…/sonata/plugins/sources/plugins/midi/web/components/midi-add-action.tsx` → `midi-create-option.ts` | Component → `midiCreateOption: CreateOption`; programmatic file pick; `openSongImperative`. |
| `…/sonata/plugins/sources/plugins/midi/web/index.ts` | Contribute `createOption` instead of `AddAction`. |
| `…/sonata/plugins/sources/plugins/chord-grid/web/components/chord-grid-add-action.tsx` → `chord-grid-create-option.ts` | Component → `chordGridCreateOption: CreateOption`; `openSongImperative`. |
| `…/sonata/plugins/sources/plugins/chord-grid/web/index.ts` | Contribute `createOption` instead of `AddAction`. |
| CLAUDE.md | `data-view` (document `creators`), `gallery` (`showCreateCard`), `home/app-cards` (creators not `actions`), `sonata/library` (`createOption`). |

## Boundary / purity notes

- `CreateOption` is generic vocabulary (`id/label/icon/onSelect`) — no pane/song/app terms.
  data-view stays domain-pure.
- Export `CreateOption` from **both** `core/index.ts` and `web/index.ts`. Sonata's slot imports
  it from `…/data-view/web`.
- Consumers never import the gallery child: `showCreateCard` is a plain literal under
  `viewOptions.gallery` (like today's `cover`/`renderCard`). The gallery child imports only the
  `CreateOption` *type* (type-only) from data-view.
- `creators-control.tsx` is host-internal — not barrel-exported.
- `openPane` (imperative, live store) vs `useOpenPane` (context store): for a click in the
  visible library these coincide. Low-risk nuance, not a regression — verify in the desktop
  multi-window case.

## Verification

1. `./equin build` (regenerates registry/docs, runs checks incl. `type-check`,
   `plugin-boundaries`, `plugins-doc-in-sync`).
2. App at `http://att-1781557754-9i4r.localhost:9000`. Use `bun e2e/screenshot.mjs` to drive:
   - **Story** (`/story`): single "New story" toolbar button **and** a trailing dashed "+"
     card; clicking either creates a story and opens it. No duplicated header.
   - **Home** (`/home`): "New app" toolbar button + trailing "+" card render; clicking is an
     inert stub (no crash).
   - **Sonata** (`/sonata`): a single "+" toolbar menu listing **Import MIDI** + **New Chord
     Grid** (no trailing card). Import MIDI opens a native file picker, imports, and navigates
     to the player; New Chord Grid creates and opens. Busy state disables the control while
     in-flight. Sort SegmentedControl still present, left of "+".
   - **Empty state:** a freshly-empty Story/Sonata DB shows `emptyState` text + a creator CTA
     button (not during loading — confirm the skeleton shows first).
3. Optional: a `bun:test` for `creators-control` rendering (0/1/N branches) if a pure seam emerges.

## Open risks

1. **Busy affordance** is now host-owned (promise-tracked) rather than per-source `useState` —
   net win but a behavior change; optional `busyLabel?` on `CreateOption` if a custom label is wanted.
2. **N-creator trailing card** intentionally omitted (a single dashed card can't express N) —
   Sonata relies on the toolbar menu.
3. **Home `onSelect` is a genuine stub** — surfaces a visible button/card that does nothing until
   a create-app flow exists (accepted per decision).
