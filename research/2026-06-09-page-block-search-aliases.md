# Block search aliases for the slash insert menu

## Context

The page editor's block pickers (slash `/` menu, gutter `+` / Add-block menu) filter
block types by a **case-insensitive substring match against each block's `label` only**
(`filterBlockTypes` in `plugins/page/plugins/editor/web/components/block-type-list.tsx`).

A block has no way to declare alternate search terms, so it is undiscoverable by any
synonym. Concretely: the Divider block (label `"Divider"`) cannot be found via `/hr`,
`/rule`, or `/separator`, and `/-` instead surfaces **To-do** (the only label containing
a hyphen). This hurts discoverability for **every** block type, not just the divider.

**Goal:** give blocks an optional `aliases` list of search keywords that the pickers match
in addition to `label`, populate sensible aliases for all existing blocks, and rank label
matches above alias-only matches so the most relevant block stays on top.

This is purely additive — the `aliases` field is optional, so no existing block breaks.

## Design

Add an optional `aliases?: string[]` to the block authoring API, extend the single shared
filter function to also match (and rank by) aliases, then populate aliases per block. All
three pickers (`slash-menu-plugin`, `block-type-menu`, `block-actions-menu`) already route
through `useInsertableBlocks` + `filterBlockTypes`, so extending those two functions covers
every picker with zero per-picker changes. (`block-actions-menu`'s "Turn into" list renders
unfiltered and needs no change.)

### 1. Authoring API — `aliases` field

`plugins/page/plugins/editor/core/define-block.ts`

- Add to the `BlockHandle<T>` interface (after `icon`, ~line 14), with a doc comment:
  ```ts
  /**
   * Optional alternate search terms for the insert menus (e.g. ["hr", "rule"] for a
   * divider). Matched in addition to `label` but ranked below label matches. Only
   * meaningful for block types that also declare a `label`.
   */
  aliases?: string[];
  ```
- Add `aliases?: string[]` to the `defineBlock` opts object (~line 60) and pass it through
  in the returned handle (`aliases: opts.aliases`, ~line 74).

No barrel change needed — `BlockHandle` is already re-exported from
`plugins/page/plugins/editor/core/index.ts`.

### 2. Filter + light ranking — `filterBlockTypes`

`plugins/page/plugins/editor/web/components/block-type-list.tsx` (replace the current
label-only `filterBlockTypes`, lines 20–28).

Match against `label` OR any `alias`, then stable-sort surviving blocks into relevance
tiers (lower = higher priority), preserving original contribution/slot order within a tier:

- tier `0`: `label` starts with the query
- tier `1`: `label` contains the query
- tier `2`: an alias starts with the query
- tier `3`: an alias contains the query

```ts
/** Case-insensitive match on a block's `label` plus its `aliases`, ranked: label
 *  matches outrank alias-only matches, and prefix matches outrank substring matches.
 *  Contribution order is preserved within each rank tier. */
export function filterBlockTypes(
  blocks: BlockHandle<unknown>[],
  query: string,
): BlockHandle<unknown>[] {
  const q = query.trim().toLowerCase();
  if (!q) return blocks;

  const rank = (b: BlockHandle<unknown>): number => {
    const label = b.label?.toLowerCase();
    if (label?.startsWith(q)) return 0;
    if (label?.includes(q)) return 1;
    const aliases = b.aliases?.map((a) => a.toLowerCase());
    if (aliases?.some((a) => a.startsWith(q))) return 2;
    if (aliases?.some((a) => a.includes(q))) return 3;
    return Infinity; // no match
  };

  return blocks
    .map((b, i) => ({ b, i, r: rank(b) }))
    .filter((x) => x.r !== Infinity)
    .sort((a, b) => a.r - b.r || a.i - b.i) // stable: tie-break on original index
    .map((x) => x.b);
}
```

### 3. Populate aliases on every block

Add an `aliases: [...]` line to each `defineBlock(...)` call. Proposed sets (final wording
adjustable during implementation):

| Block | File (`core/*-block.ts`) | Proposed `aliases` |
|---|---|---|
| Text | `plugins/page/plugins/text/core/` | `["paragraph", "plain", "body", "p"]` |
| Bulleted list | `plugins/page/plugins/bulleted-list/core/` | `["bullet", "unordered", "ul", "list"]` |
| To-do | `plugins/page/plugins/to-do/core/to-do-block.ts` | `["checkbox", "task", "checklist", "todo"]` |
| Toggle | `plugins/page/plugins/toggle/core/` | `["collapsible", "accordion", "details", "expand"]` |
| Divider | `plugins/page/plugins/divider/core/divider-block.ts` | `["hr", "rule", "separator", "line", "horizontal rule", "---"]` |
| Code block | `plugins/page/plugins/code-block/core/` | `["snippet", "syntax", "monospace", "pre"]` |
| Image | `plugins/page/plugins/image/core/` | `["picture", "photo", "img", "media"]` |
| Page link | `plugins/page/plugins/page-link/core/` | `["link", "reference", "subpage"]` |

Note: the Divider `"---"` alias makes `/-` surface the Divider alongside To-do (To-do still
matches on its hyphenated label), resolving the reported `/-` confusion.

## Files to modify

1. `plugins/page/plugins/editor/core/define-block.ts` — add `aliases` to interface + opts + passthrough.
2. `plugins/page/plugins/editor/web/components/block-type-list.tsx` — rewrite `filterBlockTypes` with alias match + ranking.
3. The eight `core/*-block.ts` files above — add an `aliases` array to each `defineBlock(...)` call.

## Verification

1. `./equin build` (from this worktree) — confirm it deploys clean.
2. `./equin check` — confirm boundary/lint/doc checks still pass (the doc-in-sync
   check may want regeneration; `build` regenerates docs first).
3. In the app at `http://<worktree>.localhost:9000` open a page (Pages app), create a text
   block, and exercise the slash menu with `e2e/screenshot.mjs` (or manual Playwright):
   - `/hr` → **Divider** appears (previously empty).
   - `/rule`, `/separator` → **Divider** appears.
   - `/-` → **Divider** and **To-do** both appear.
   - `/check` → **To-do** appears.
   - `/code` → **Code block** ranks first (label match) above any alias-only matches.
   - `/text` → **Text** still appears and ranks first (regression check on the existing path).
4. Repeat one alias query (e.g. `/hr`) in the gutter **+ / Add block** menu to confirm the
   shared filter covers that picker too.
