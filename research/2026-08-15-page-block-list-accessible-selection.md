# The block list is a document, not a listbox

## Context

`plugins/page/plugins/editor/web/components/block-editor.tsx:1319-1323` declares the
block-selection container as

```tsx
<Overlay as="div" ref={containerRef} tabIndex={-1}
         role="listbox" aria-multiselectable aria-label="Page blocks" …>
```

and nothing below it carries `role="option"` or `aria-selected`. Two failures follow,
and the second is the worse one:

1. **Selection is conveyed by colour alone.** Since commit `322e06e9f` the highlight is
   a `SelectionBands` sibling decoration carrying `aria-hidden` (correctly — it *is*
   decoration), and `BlockRow` paints nothing of its own. So a screen-reader user has no
   signal at all that any block is selected, how many, or which.
2. **The lie destroys the document.** A `listbox` presents its subtree as a flat list of
   options; content that is not an option is commonly dropped. So the whole point of the
   page — headings, lists, quotes, paragraphs — is *hidden* by an attribute added to help.
   Today's role is strictly worse for AT than no role at all.

The constraint that makes the obvious fix wrong: every row contains a `contenteditable`
editing host. Stamping `role="option"` on a row flattens that editing host into an
option's name and destroys the editing semantics AT relies on.

**Intended outcome:** the surface tells the truth about what it is, block selection is
announced when it changes, and a selected block says so when read.

## The decision: there is no honest composite role here, so don't claim one

`aria-selected` is only supported on `gridcell`, `option`, `row`, `tab`, `treeitem`,
`columnheader`, `rowheader`. None of those can host a rich-text editing host. And the
mode cannot be role-switched either: `contentEditable={false}` while selecting is
explicitly ruled out by the editor's own caret-authority invariant (it deadlocks the
landing — see the editor `CLAUDE.md`).

So the container becomes what it actually is — **a named group of editable blocks** —
and the selection state, which has no native carrier here, gets an explicit announcement
channel plus a per-row textual marker.

| | Today | After |
|---|---|---|
| Container | `role="listbox" aria-multiselectable` | `role="group" aria-label="Page blocks"` |
| Rows | nothing | unchanged semantics + an `sr-only` "Selected." marker when selected |
| Selection change | silent | announced through a live region |

## Work

### 1. New primitive — `plugins/primitives/plugins/announce/`

There is **no** screen-reader announcement primitive in the repo today (the only
`aria-live` anywhere is baked inline into `mail-sync-banner.tsx`). Build it once, here,
so the next surface with a colour-only state change has somewhere to route.

- `web/internal/announcer-store.ts` — module-level store (`subscribe`/`getSnapshot`,
  push-based, no timers) holding `{ politeText, assertiveText }`.
  Re-announcing an identical string must re-fire, so the store appends a toggling
  `" "` on alternate writes rather than clearing on a timer.
- `web/components/announcer-host.tsx` — two `sr-only` divs,
  `role="status" aria-live="polite" aria-atomic` and `role="alert" aria-live="assertive"`,
  reading the store through `useSyncExternalStore`.
- `web/index.ts` — `export { announce }` (signature `announce(message: string, opts?: { assertive?: boolean })`),
  plus `contributions: [Core.Root({ component: AnnouncerHost })]`.
  Mirrors `plugins/shell/plugins/toast/web/index.ts` byte-for-byte in shape, including
  its "degrades to a silent no-op when no host is mounted" behaviour.
- `CLAUDE.md` stating the one rule: **an announcement is for a state change with no
  native carrier**; anything a control already announces itself (a checkbox, a button's
  `aria-pressed`) must not be announced again.

### 2. New lint plugin — `plugins/framework/plugins/tooling/plugins/lint/plugins/aria-safety/`

The defect is a *composite ARIA role declared without the children the role requires*.
That is statically checkable at the only altitude where it is knowable — the file that
declares the container:

- rule `no-orphan-composite-role`: a JSX `role="listbox" | "tablist" | "tree" | "treegrid" |
  "grid" | "menu" | "menubar" | "radiogroup"` is an error unless the same file also
  contains a JSX element carrying one of that role's required child roles
  (`option`, `tab`, `treeitem`, `row`, `menuitem`/`menuitemcheckbox`/`menuitemradio`,
  `radio`). A legitimately cross-file pairing takes an
  `// eslint-disable-next-line aria-safety/no-orphan-composite-role -- <where the children are>`,
  which turns the pairing into an explicit, reviewed decision instead of an invisible one.
- Shape copied from `plugins/framework/plugins/tooling/plugins/lint/plugins/button-safety`
  (`lint/index.ts` default-exporting `{ name, rules }`, plus `package.json` + `CLAUDE.md`;
  no runtime barrels). **Rule files must be self-contained** — jiti cannot resolve
  `@plugins/*` from a lint file.
- Existing declaration sites to verify after enabling (all already pair in-file, so this
  should be clean): `file-tabs.tsx`, `log-viewer.tsx` (tablist/tab),
  `radio-group.tsx` (radiogroup), `command-palette-dialog.tsx` (option — child side,
  not flagged by this rule).

### 3. The editor — `plugins/page/plugins/editor`

**`web/components/block-editor.tsx`**
- `role="listbox" aria-multiselectable` → `role="group"`; keep `aria-label="Page blocks"`.
- Pass the new `describeBlock` and `isSelected` down (below).

**`web/internal/use-block-selection.ts`** — the announcement funnel.
`applyRange` / `clearSelection` / the Cmd+A branch are the *only* three places the range
changes, so announcing there is exact, push-based, and costs no render. The hook stays
domain-free: it takes a new option

```ts
/** How a block reads aloud, e.g. `Heading 2: Container frames`. */
describeBlock: (id: string) => string;
```

Announcements (polite):
- range applied → `` `${describeBlock(head)}, block ${i} of ${n}${count > 1 ? `, ${count} blocks selected` : ", selected"}` ``
  where `count = |idx(anchor) − idx(head)| + 1` from `orderedIds` — the same arithmetic
  the multi-select reducer's `SET_RANGE` does.
- select-all → `` `All ${n} blocks selected` ``
- clear → `"Selection cleared"`, **guarded on `anchorRef.current !== null`** so the
  focus-out and post-delete clears don't announce into silence.

`describeBlock` is built in `SelectionLayer`, which already holds `flat` and the
`Editor.Block` handle map: `` `${handle?.label ?? "Block"}: ${plainOf(runsOf(block.data.text)).slice(0, 80)}` ``
(`plainOf`/`runsOf` from `../../core`), degrading to just the label for a text-less type.

**`web/components/block-row.tsx`** — the per-row marker.
- New `isSelected: boolean` prop, computed by the parent from the `selectedIds` it
  already holds. **Not** `useMultiSelectItem` — the parent re-renders every row on a
  selection change anyway (it recomputes `selectionBands`), so a prop costs nothing while
  a per-row context subscription would newly couple every row to the selection store.
- Render, in **both** branches (ordinary row and the zero-height anchor row), as a
  constant-position first child:
  `<span className="sr-only">{isSelected ? "Selected. " : ""}</span>`
  Always rendered — never conditionally mounted — so the row's children array keeps a
  constant length (the fiber-index pairing hazard the editor's `CLAUDE.md` documents for
  `text-block-layout.tsx` applies to any row-level sibling list). `sr-only` is
  `position:absolute`, so it perturbs no rect that drag/drop/marquee measures.

### 4. Callers and specs

- `plugins/page/plugins/image/e2e/image-block.ts:31` —
  `getByRole("listbox", { name: "Page blocks" })` → `getByRole("group", …)`.
  Re-grep for `listbox` before finishing; that is the only known caller.
- `plugins/page/plugins/editor/web/__tests__/block-selection.test.tsx` — add:
  the container exposes `role="group"` and no `listbox`; entering selection mode,
  extending, select-all and clearing each push the expected announcement text;
  a clear with nothing selected announces nothing.
- New `plugins/primitives/plugins/announce/web/__tests__/announcer.test.tsx` — the
  host renders the polite text, and two identical consecutive announcements produce two
  distinct rendered strings (the re-announce rule).

### 5. Documentation

- `plugins/page/plugins/editor/CLAUDE.md` — a new section, **"The block list is a
  document, not a listbox"**, next to *"The selection highlight belongs to the RUN"*:
  why no composite role is honest here, why `aria-selected` is unreachable, and the two
  channels that replace it. Include the "don't re-add `role="option"`" warning explicitly —
  it is the fix everyone reaches for first.
- `plugins/primitives/plugins/announce/CLAUDE.md` — the primitive's own rule (above).

## Deliberately out of scope (file as follow-ups)

- **Heading blocks do not expose `role="heading"` / `aria-level`.** Now that the listbox
  no longer flattens the subtree this is the next-largest AT gap, but it belongs to the
  block-type presentation API (`BlockChrome`), not to the selection surface.
- **`multi-select`'s `SelectionBar` is not a live region.** Other surfaces convey
  selection through native checkboxes, so a generic announcement there would double-speak;
  the page editor is the one surface with no native carrier and it announces richly.
- **`mail-sync-banner.tsx` keeps its inline `role="status"`** — a persistent *visible*
  status strip is a legitimate inline live region, not an announcement.

## Verification

1. `./equin build` (background) — must pass `eslint` (the new rule runs repo-wide)
   and `type-check`.
2. `./equin test plugins/page/plugins/editor plugins/primitives/plugins/announce`.
3. Manual, at `http://att-1786829493-vjp5.localhost:9000/pages`: open a page, press
   Escape in a block, arrow up/down, Shift+arrow, Cmd+A, Escape. Inspect the live region
   in devtools (`[role="status"]`) and confirm the text updates on every step; confirm
   `[role="listbox"]` no longer exists and the container is `[role="group"]`.
4. `bun plugins/page/plugins/editor/e2e/block-selection-verify.ts` and
   `bun plugins/page/plugins/image/e2e/image-block.ts` — the existing specs must still pass
   (the second is the role-rename caller).
