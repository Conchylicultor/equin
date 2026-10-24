# Config listField persistence: terse, array-ordered, noise-free

**Date:** 2026-07-21
**Status:** Plan → implementing

## Problem

A committed DataView view authored terse/stable (e.g. `{"id":"tree","name":"Tree","view":{…}}`)
comes back from the **user config layer** heavily mutated on the *first* user edit:

1. **ids re-minted** to `auto-<hash>` (id-less rows) / `view-<uuid>` (new rows), so the
   git default and the user copy diverge by opaque id even when content is identical.
2. **an extra `rank` field** on every row — a second ordering axis redundant with array
   position, which drifts from and "conflicts" with array order.
3. **no-op noise**: `"filter": {…,"children":[]}`, `"sort": []` replacing a real default
   sort, `"filter": null` — semantically-empty values persisted as explicit keys.

All three make the user-layer document diverge from the terse git default, so a layer diff
is unreadable and promoting user→git commits opaque generated ids + redundant fields into a
hand-reviewed file.

## Root causes

| Symptom | Origin |
|---|---|
| `rank` on every row | `injectCollectionIds` (config_v2 `server/internal/registry.ts:43-75`) mints `Rank.between(...)` for every listField item, on **read and write** (`registry.ts:96,467`). Redundant: config writes are always full-document, so fractional rank buys nothing over array order. |
| `auto-<hash>` ids | Same function mints `auto-${computeHash([index,content])}` for id-less rows and **ignores `stableIdentity`**. The `config-stable-list-ids` check only scans git `config/**/*.jsonc` (not `.origin.jsonc`, not the user layer) → zero runtime protection. The auto-id is content+position-derived (unstable) yet locks in permanently on first edit. |
| no-op `sort`/`filter` | data-view's controllers write literal empty sentinels: `setRules([])`→`sort:[]`, `setFilter(null)`→`filter:null`, `emptyGroup()`→`{children:[]}` — via `updateView(…,{merge:true})`. Once written they are sticky keys, re-serialized on every future edit of any sibling row (view-core rewrites the **whole array** on any edit). |

## Design

**Principle:** the persisted config document should stay as terse as the authored git default.
Array position is the canonical order; identity is authored (stable lists) or a render-only
seed (render lists); empty host values omit their key.

### Part A — Array order is canonical; remove `rank` from listFields

Config writes are always full-document (`setConfig` writes `{…current,[key]:value}`), so a
fractional `rank` is pure overhead over array index. Make array position authoritative.

- **`injectCollectionIds` → `normalizeCollectionItems`** (config_v2 `registry.ts`):
  - stop minting `rank`;
  - **one-time migration:** if items carry a legacy `rank`, sort by it (`Rank.compare`) into
    array order, then drop `rank` from every item. Idempotent — after the first read+write a
    file is array-ordered and rank-free.
  - **respect `stableIdentity`:** for a `stableIdentity` list, do **not** synthesize ids
    (the consumer owns identity — view-core derives a readable slug). For render lists keep
    the existing persisted `auto-<hash>` id (stable after first write — unchanged).
- **`fields/list`**: drop `rank` from the `ListItem<F>` type and from the `default?` author
  type (keep `rank: z.string().optional()` in the zod item schema for legacy-read tolerance
  only). The type removal surfaces every reader as a compile error.
- **`ListRenderer`** (settings list editor): reorder by array splice (`arrayMove`), add by
  append — no `Rank`.
- **view-core `use-views-config.ts`**: `ViewConfigRow` drops `rank`; order = array position;
  `reorderView` splices the array; `addView`/`duplicateView` insert at array position; id =
  `row.id ?? slugify(name) ?? view-${i}` (readable, unchanged minus rank).
- **`plugin-meta/composition`** + **`review/code-review`**: drop `rank` from code defaults and
  from `manifests.ts` ordering (array order now — deletes the rank-sort compensation).
- **`config_v2/settings` config-field-row**: drop the now-dead `rank:_rank` destructure.

### Part B — Empty host values omit their key (no-op noise)

- **view-core `mergeView`**: after applying the caller's patch, drop keys whose value is
  `undefined`, so a host can signal "remove this key" (JSON.stringify already drops undefined,
  but the in-memory mirror must match so JSON-identity reconcile is stable).
- **data-view `use-data-view-model.ts`**: write key-omission for empties:
  - `setSortRules(id, rules)` → `sort: rules.length ? rules : undefined`
  - `setFilter(id, filter)` → `filter: isEmptyFilter(filter) ? undefined : filter`
    (`isEmptyFilter` = `null` or a group with no children)
  - `setVisibleFields(id, ids)` → `visibleFields: ids ?? undefined` (reset = show all)

  An omitted key round-trips identically to today's `[]`/`null` (the user-override row wins
  wholesale, so absence = "no sort/filter for this row"), just without the noise.

### Migration of existing user docs

No forced migration. Existing user-layer files carry rank + no-op noise; the read-side
`normalizeCollectionItems` sorts-by-rank then drops it, and the next edit rewrites the file
clean. The only committed file with `rank` is `compositions.origin.jsonc` (regenerated by
`./equin build`).

## Blast radius (bounded)

- `reorder` uses `reorderTreeField`, **not** `listField` — unaffected.
- `config-nav` rank is independently generated (`flatten-config-tree.ts`) — unaffected.
- listField consumers: views, sort/filter presets, custom-columns, composition manifests,
  code-review paths, preprompts, categories, prompt-templates, etc. — all render in array
  order or via `ListRenderer`; only composition + view-core + ListRenderer read `rank` today.

## Follow-ups (filed, not in scope)

- Extend `config-stable-list-ids` to also validate propagated origins / surface a loud runtime
  warning when a `stableIdentity` row reaches the registry without an explicit id.
