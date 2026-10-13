# Pinned sort rules (DataView) + "keep folders on top" (file explorer)

## Context

The file explorer lists folders first only because `visibleEntries`
(`plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx:66`)
mints the row ranks in that order. Rank is only the fallback order: once the
user clicks a column header (Modified, Size…), the DataView sort replaces it and
folders get mixed in with files. Users expect Finder's **Keep folders on top**.

A "Folder" field used as the first sort rule looks right, but it breaks on the
first header click. Header toggles run `cyclePrimarySort`
(`plugins/primitives/plugins/data-view/web/internal/sort-cycle.ts:13`), which
puts the clicked field at index 0, ahead of the folder rule.

**Outcome:** DataView gets one generic primitive, a **pinned sort rule**. It
always sorts first, and header clicks, presets and "Clear sort" never displace
it. The file explorer uses it to keep folders on top by default, and the user
can turn it off.

## Design

### 1. `SortRule.pinned` (DataView core)

`plugins/primitives/plugins/data-view/core/internal/types.ts:518`:

```ts
export interface SortRule {
  fieldId: string;
  direction: "asc" | "desc";
  /** Sorts before every unpinned rule; header cycling, preset apply and
   *  "Clear sort" leave it in place. Pinned rules form a prefix of the list. */
  pinned?: true;
}
```

**Invariant:** pinned rules are a prefix of `SortRule[]`. A new pure module,
`web/internal/pinned-sort.ts`, owns it:

- `splitPinned(rules) → { pinned, user }`
- `normalizeSortRules(rules)`: a stable partition, pinned first.

Enforce the invariant at both config boundaries:

- **Read:** `readSortRules` (`web/internal/use-data-view-model.ts:134`) returns
  `normalizeSortRules(...)`. A hand-edited config or legacy row can then never
  put a pinned rule behind a user rule.
- **Write:** `setSortRules` and `setSort` (same file, lines 294 and 308)
  normalize before `updateView`.

**Why a flag on the rule, not a separate `pinnedSort` key:** every place that
applies a sort keeps iterating one list unchanged:

- `makeSortComparator` (`web/internal/sort-rows.ts`)
- `use-flat-rows.ts:66`
- the tree's global sort (`plugins/tree/web/components/tree-view.tsx:417`)
- the live `orderBy` lowering (`web/internal/live-source.tsx:~238`)
- `body-state.ts:94`

So none of them can forget the pinned rules. Only the places that *edit* rules
need to know about pinning, and those are few and listed below.

### 2. Editing semantics (the only pin-aware code)

- **`cyclePrimarySort`** (`sort-cycle.ts`): split the list. The header cycles
  the first *user* rule with today's logic (asc → desc → removed), then the
  pinned prefix is put back in front.
  - Clicking the header of a *pinned* field flips that pinned rule's direction
    and never removes it, so a header can't silently delete a pin.
  - A user rule on a field that is already pinned is never created.
- **`useSortController`** (`web/internal/use-sort-controller.ts`):
  - New `togglePinned(fieldId)`. Pinning moves the rule to the end of the
    pinned prefix; unpinning moves it to the head of the user rules.
  - `move` clamps within the rule's own segment.
  - `clear` keeps the pinned rules. An explicit remove still deletes a pinned
    rule.
  - `addRule` and `setField` keep their uniqueness checks.
  - `ruleCount` stays as it is, counting pinned rules too: they are real sorts
    and the pill should say so.
- **Presets** (`web/internal/sort-presets.ts`, `use-sort-presets.ts`,
  `web/components/sort/presets.tsx`): a preset stores only the user rules.
  - `savePreset` strips pinned rules.
  - Applying a preset gives `[...pinned, ...resolvableRules(preset)]`, minus
    any preset rule on a pinned field.
  - `presetMatchesRules` compares against the user rules.
  - No change to `shared/sort-presets-field.ts`.
- **Sort panel** (`web/components/sort/sort-control-panel.tsx`,
  `sort-rule-row.tsx`):
  - Each rule row gets a pin toggle (a pin icon button, `aria-pressed`).
  - Pinned rows come first, in their own drag segment.
  - "Clear sort" reads "Clear sort" when user rules exist and is hidden when
    only pinned rules remain.
- **Header arrows:**
  - The table (`plugins/table/web/components/table-view.tsx:51` `mapPrimary`)
    shows the first *user* rule, not `rules[0]`.
  - The tree's aligned columns (`aligned-columns.tsx:209`) already match by
    field and stay as they are. A pinned rule's column also shows its arrow,
    which is correct because it is sorted.
- **`summarizeSort`** (`web/internal/summarize-sort.ts`) prefixes pinned rules
  with a pin glyph or "📌" so that "sorted by Folders, Modified" reads clearly.

### 3. File explorer: "Folders" field and default pinned rule

In `file-tree.tsx`:

- Add a hidden, sortable field:
  ```ts
  { id: "folders", label: "Folders", type: "number", visible: false,
    value: (r) => (r.kind === "dir" ? 0 : 1) }
  ```
  Ascending puts folders on top. Descending puts them at the bottom, which is
  harmless. The field shows nowhere in the body, but the user can re-add and
  re-pin it from the sort panel.
- `visibleEntries` drops its folders-first ordering and ranks by name only. The
  pinned rule now owns folders-first, so there is one source of the ordering,
  not two.
- `config/apps/file-explorer/browser/file-explorer.tree.jsonc`:
  - Set the view to
    `"view": { "type": "tree", "sort": [{ "fieldId": "folders", "direction": "asc", "pinned": true }] }`.
  - Update the comment.
  - Respect the `@hash` / `.origin.jsonc` mechanism: regenerate through the
    normal config path rather than hand-editing the hash.
  - User-layer rows that already hold a `sort` won't get the pin. That is
    acceptable, because they re-add it from the panel.
- With the rule always present, the tree's comparator is always active, and
  ties fall back to the incoming rank (name). Behavior:
  - No user sort: folders first, then by name. Same as today.
  - Header click on Modified: folders by date, then files by date.
  - Unpin or remove the rule: the plain field sort mixes folders and files,
    which is the "off" state.
- Check: `sortActive` disables tree drag-reorder (`tree-view.tsx:686`), and
  `manualOrderOverridden` (`data-view-body.tsx:983`) needs a manual-order
  config. The file tree has neither, so nothing changes. Confirm during
  implementation.

## Critical files

- `plugins/primitives/plugins/data-view/core/internal/types.ts`: the
  `SortRule.pinned` field
- `plugins/primitives/plugins/data-view/web/internal/`:
  - `pinned-sort.ts` (new)
  - `sort-cycle.ts`
  - `use-sort-controller.ts`
  - `use-data-view-model.ts`
  - `sort-presets.ts`
  - `use-sort-presets.ts`
  - `summarize-sort.ts`
- `plugins/primitives/plugins/data-view/web/components/sort/`:
  - `sort-control-panel.tsx`
  - `sort-rule-row.tsx`
  - `presets.tsx`
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx`
- `plugins/apps/plugins/file-explorer/plugins/browser/web/components/file-tree.tsx`
- `config/apps/file-explorer/browser/file-explorer.tree.jsonc`
- `plugins/primitives/plugins/data-view/CLAUDE.md`: a "Pinned sort rules"
  paragraph next to the multi-level sort docs (around lines 104–110)

## Verification

- **Unit tests** (`./singularity test plugins/primitives/plugins/data-view`):
  - `sort-cycle.test.ts`:
    - A header click on a user field keeps the pinned prefix.
    - Cycling to empty keeps the pinned rules.
    - A click on a pinned field flips its direction.
  - New `pinned-sort.test.ts`: `normalizeSortRules` and `splitPinned`.
  - `sort-presets.test.ts`: save strips pinned rules, and apply keeps them.
  - `summarize-sort.test.ts`: the pinned glyph.
  - `sort-rows.test.ts`: a pinned rule followed by a user rule gives folders
    first, then by date.
- **Build:** `./singularity build`, then open
  `http://<worktree>.localhost:9000/files/at/~%2FDownloads`:
  - With no header sort, folders are on top.
  - Click Modified, then click again: folders stay on top in both directions.
  - The sort panel shows "Folders" pinned. Unpinning it mixes folders and
    files, and re-pinning restores folders on top.
- **E2E:** extend `plugins/apps/plugins/file-explorer/e2e/expand-scroll-verify.ts`
  (it already relies on folders first), or add `e2e/folders-on-top-verify.ts`.
  The new script clicks the Modified header and asserts that every dir row
  precedes every file row at the root level.
- **Checks:** `./singularity check` (type-check, plugins-doc-in-sync, config
  hash).
