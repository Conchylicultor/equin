# Nested config list rows get an id — one recursive walk instead of three top-level ones

## Context

A `listField` nested inside another `listField`'s `itemFields` produces rows with
no `id`. The renderer needs one at every depth; nothing produces one except the
Settings-pane "Add item" button.

Where the `id` is used — `plugins/fields/plugins/list/plugins/config/web/`:

| use | site |
| --- | --- |
| React `key` | `components/list-renderer.tsx:82` |
| dnd-kit sortable id | `components/list-renderer.tsx:22`, `components/list-item-row.tsx:23` |
| reorder splice lookup | `components/list-renderer.tsx:28-29` |
| edit-matching predicate | `components/list-renderer.tsx:38` — `item.id === updated.id` |
| remove-by-id | `components/list-renderer.tsx:45` |

Where an `id` comes from:

- `handleAdd` (`list-renderer.tsx:50-63`) mints `crypto.randomUUID()` — rows added
  through the UI are fine.
- `normalizeCollectionItems` (`plugins/config_v2/server/internal/registry.ts:49-98`)
  seeds `auto-<hash([index, content])>` for id-less rows — **but its only loop is
  `Object.entries(fields)` over the descriptor's top-level `FieldsRecord`.** It
  never recurses into a list's `itemFields` or an object's `subFields`. A nested
  row is shallow-copied and passed through untouched.

So a hand-authored or code-defaulted nested row carries `id === undefined`. The
consequences are silent: duplicate React keys, dead reorder, and — worst —
`value.map(item => item.id === updated.id ? updated : item)` rewrites **every**
id-less row in the list when you edit one of them.

Two more places walk the same recursive schema non-recursively, and drift with it:

- `config-stable-list-ids`
  (`plugins/framework/plugins/tooling/plugins/checks/plugins/config-stable-list-ids/check/index.ts:61-67`)
  — same top-level-only loop, with a comment saying so. A nested
  `stableIdentity` list is unenforced today.
- `isFieldModified`
  (`plugins/config_v2/plugins/settings/web/components/config-field-row.tsx:16-29`)
  — strips only the **top-level** `id` before diffing a value against
  `descriptor.defaults`. Once nested rows carry ids this comparison starts
  reporting "modified" for untouched configs (`review/code-review`'s
  `sections[].patterns` default rows are code-authored and carry no ids).

Hit while adding a nested per-category `items` list to
`conversations/conversation-category`, where the only defence was remembering to
hand-write an `id` on every nested row.

**The structural issue is not the missing id — it is that a recursive schema is
walked non-recursively in three independent places.** The fix is one shared
recursive walk that all three consume.

## What the user should be able to write

```jsonc
// config/conversations/conversation-category/config.jsonc
"categories": [
  { "id": "priority", "name": "Priority",
    "items": [ { "name": "P0" }, { "name": "P1" } ] }   // no hand-written ids
]
```

…and get working reorder, working per-row editing, and — if `items` were ever
declared `stableIdentity: true` — a build-time failure telling them to write ids.

## Design

### 1. New primitive — `mapConfigLists` (`plugins/config_v2/core/internal/collections.ts`)

The one definition of "where the list instances are in a config document". Pure,
returns a new doc, copies only along touched paths.

```ts
export type ConfigListVisitor = (
  items: Record<string, unknown>[],
  field: ListFieldDef,
  path: string,               // e.g. `categories[0].items`
) => Record<string, unknown>[] | void;   // void ⇒ keep as-is

export function mapConfigLists(
  doc: Record<string, unknown>,
  fields: FieldsRecord,
  visit: ConfigListVisitor,
): Record<string, unknown>;
```

Traversal, per `[key, field]` of `fields`:

- `isListFieldDef(field)` and `doc[key]` is an array → call `visit(items, field, path)`,
  then **recurse into each returned item** with `field.itemFields` and path
  `` `${path}[${i}]` ``.
- `isObjectFieldDef(field)` and `doc[key]` is a plain object → recurse with
  `field.subFields`.
- anything else (including the opaque `jsonField` / `variantField`) → untouched.

**Visit-before-recurse is load-bearing, not incidental.** The outer row's
`auto-` seed hashes the row's content, which contains the nested array. Seeding
the outer id *before* nested ids exist reproduces today's hash byte-for-byte, so
no existing top-level auto id changes value. Recursing first would re-mint every
top-level auto id in every descriptor that has a nested list. Put this in the
function's doc comment.

Home: `config_v2/core` rather than `fields/core` — `isListFieldDef` /
`isObjectFieldDef` live in each field type's `plugins/config/core`, which
already imports `fields/core`, so a walker there would close a cycle.
`config_v2/core` sits above both (no cycle: neither list nor object config-core
imports config_v2) and is importable by all three consumers, including the
`check/` runtime, which already imports `APP_SCOPE_DIR` from it.

Naming `listField` and `objectField` explicitly is deliberate: "a container
holds either one nested document or an array of them" is a closed two-member
set, which per CLAUDE.md belongs as plain code in `core/`, not behind a slot. If
a third container field type ever appears, promote container-ness to a marker on
`FieldDef` then — not now.

### 2. `normalizeCollectionItems` becomes the visitor

`plugins/config_v2/server/internal/registry.ts:49-98` — keep the body (rank
migration, `delete out.rank`, `stableIdentity` short-circuit, `auto-` seed)
verbatim; move it into a `mapConfigLists` visitor. The function keeps its
signature, its three call sites (`readEntryValues`, `setConfig`,
`mergeConflictByPath`) and its contract (idempotent, new object, never mutates).

Semantics that stay unchanged:

- `stableIdentity` is **per-list, not inherited**. A nested list inside a
  `stableIdentity` parent declares its own flag. `conversation-category`'s
  `items` stays non-stable — classification rows key on the item's *name*
  (`shared/schemas.ts`), so nested ids are render-only and content-derived seeds
  are correct.
- The auto-id formula is unchanged at every depth. Sibling nested lists could in
  principle collide (same content, same index, different parent row), which is
  harmless: each `ListRenderer` mounts its own `DndContext`
  (`plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx:81`),
  and every consumer of `id` is scoped to one array.

### 3. `config-stable-list-ids` recurses

Replace the top-level `stableKeys` loop with `mapConfigLists(doc, descriptor.fields, …)`,
validating inside the visitor when `field.stableIdentity === true`: non-empty
string `id` on every row, unique **within that one list instance**. Use the
walker's `path` in the message, e.g.

```
config/…/config.jsonc: row "P0" in list "categories[0].items" has no explicit "id"
```

No committed config fails today — the only three `stableIdentity: true`
declarations (`data-view` view-core `views`, `conversation-category` `categories`,
`plugin-meta/composition`) are all top-level. This is pure future-proofing, which
is the point: the next nested durable-key list fails at build time instead of
silently.

### 4. `isFieldModified` strips ids at every depth

`plugins/config_v2/plugins/settings/web/components/config-field-row.tsx:16-29`.
Run both `value` and `defaultValue` (which is `descriptor.defaults[key]`, raw and
id-less — `config-detail.tsx:123`) through the same `mapConfigLists` visitor that
drops `id`, then compare. This also fixes the pre-existing gap where an
`objectField` wrapping a list took the plain `JSON.stringify` branch.

### 5. Docs

Remove the "top-level only" claims, which are the trap written down:

- `plugins/framework/plugins/tooling/plugins/checks/plugins/config-stable-list-ids/CLAUDE.md`
  ("Only **top-level** list fields are checked…")
- `plugins/fields/plugins/list/CLAUDE.md` and
  `plugins/fields/plugins/list/plugins/config/CLAUDE.md` — state that the
  `auto-` seed applies at every nesting depth
- `plugins/config_v2/CLAUDE.md` — one line in *Internal architecture* naming
  `mapConfigLists` as the shared walk

## Files

| file | change |
| --- | --- |
| `plugins/config_v2/core/internal/collections.ts` | **new** — `mapConfigLists` |
| `plugins/config_v2/core/index.ts` | export `mapConfigLists`, `ConfigListVisitor` |
| `plugins/config_v2/server/internal/registry.ts` | `normalizeCollectionItems` body → visitor |
| `…/checks/plugins/config-stable-list-ids/check/index.ts` | recurse; path in message |
| `plugins/config_v2/plugins/settings/web/components/config-field-row.tsx` | recursive id strip |
| 4 × `CLAUDE.md` | drop the top-level-only claims |

Explicit non-goals: `ListItem<F>.id` stays required-in-type /
`.optional()`-on-the-wire (unchanged, deliberate — see
`plugins/fields/plugins/list/plugins/config/core/internal/list.ts:74-76`);
`config-origin-gen` still writes `descriptor.defaults` verbatim, so no origin
`@hash` moves and `config-origins-in-sync` is untouched.

## Verification

1. **Unit** — extend `plugins/config_v2/server/internal/normalize-collection-items.test.ts`
   (all existing cases must stay green, unchanged):
   - a nested id-less row gets an `auto-` id;
   - a list inside an `objectField` inside a list gets ids;
   - **idempotence**: `normalize(normalize(doc))` deep-equals `normalize(doc)`;
   - **no top-level churn**: a doc with a nested list yields the same top-level
     `auto-` id as the pre-change implementation (pin the literal hash);
   - a nested `stableIdentity: true` list is left as authored;
   - nested `rank` is migrated then dropped.
   New `plugins/config_v2/core/internal/collections.test.ts` for the walker
   itself (paths emitted, non-container fields skipped, input not mutated).
   ```bash
   ./equin test plugins/config_v2
   ```
2. **Check** — `./equin check config-stable-list-ids` passes on the repo as
   it stands; then temporarily flip `conversation-category`'s nested `items` to
   `stableIdentity: true` and confirm it *fails* naming `categories[0].items`,
   and revert.
3. **Build** — `./equin build`; confirm `config-origins-in-sync` still
   passes (no origin hash should move) and the deploy receipt at
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
4. **End to end**, at `http://<worktree>.localhost:9000/settings`, on the
   `conversations/conversation-category` config:
   - hand-edit `~/.singularity/config/<wt>/conversations/conversation-category/config.jsonc`
     to add two nested `items` rows **without** ids, reload, and confirm each row
     edits independently (the old bug rewrote both) and drag-reorder works;
   - confirm the nested rows now carry `auto-` ids in the file after any edit.
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/settings --out /tmp/nested-list
   ```
5. **Regression on the modified badge** — open the `review/code-review` config
   (code-defaulted nested `sections[].patterns`) and confirm no field shows the
   "modified" badge or an active reset affordance before any edit.
