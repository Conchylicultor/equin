# DataView fields everywhere — [Guard]: refuse the old shapes

Track page: `block-85963184-057d-4983-a5f0-c9183ae8d71c` (exit criterion 4). Builds on
`research/2026-10-18-global-dataview-lists-derive-fields.md` and
`research/2026-10-18-page-page-blocks-become-entity.md`.

## Context

[Entities] and [Lists] moved every DB-backed list onto the derived path:
entity → `liveCollection({ from, pick })` → DataView. Nothing stops the old shapes from
coming back. Today all three still type-check:

1. **A collection that lists its own fields over a table.** `liveCollection` without `from`,
   then `serveCollection(c, { from: someTable })`. It still exists in practice:
   - Over `defineEntity` tables: browser bookmarks, mail reading pane (`mail_messages`),
     conversation summaries, plugin-health reviews, task `pushes`, and the queue ranks
     (`carry` only, over the `conversations_queue` extension).
   - Over raw `pgTable`s with no entity: pending questions (question-relay), conversation
     turns (turn-ledger), usage stats (usage-rank).
2. **`defineEntity("name", fields, meta)`** skips the core ref. There are 19 such calls:
   tasks-core ×3, summary, session-chain, page tags, plugin-health, mail-core ×8, bookmarks,
   event_source_run_events and sonata track-mixer.
3. **A DataView over DB rows handed `fields`.** `fields` beside `source=` or `collection=` fails
   only at runtime (`listSchema`, `data-view/web/internal/derived-fields.tsx:578`). Rows from
   `useLive(collection)` passed as `rows` with hand `fields` are not refused at all.

Each refusal below takes the highest rung of the fix ladder that can express it.

## Design

### A. `defineEntity` takes only a ref (rung 1: no spelling)

- Delete the two `(name: string, fields, meta?)` overloads and the string branch of the
  implementation (`infra/entities/server/internal/define-entity.ts:140-175`). Keep
  `defineEntity(ref)`, `(ref, meta)` and `(ref, serverFields, meta)`.
- Move each of the 19 call sites to `entityRef(name, fields)` in the plugin's `core/`, with
  `defineEntity(ref, …)` on the server. Columns that only the server may see (dedup keys,
  tokens) go in `serverFields`, as [Entities] did. Field records come from `fields/core`, so
  they are browser-safe. The goal is no DDL change: the build must generate no migration.
- Update the static readers that parse `defineEntity("<name>"…)` so they read ref bindings
  only: `database/change-feed/check/producer-writes.ts` and
  `plugin-meta/facets/db-schema/facet/index.ts:124-176`. Their tests and
  `define-entity.test.ts` / `derived-updated-at.test.ts` switch to `entityRef(...)`.
- Once the string form is gone, every entity has a core ref, so "a table that has an entity"
  and "a table with a ref" mean the same thing.

### B. A served collection reads an entity, and is `from` it

- **Type (rung 2).** In `network/live/server/internal/collection-source.ts`, narrow
  `CollectionSource` from `RoutedSource` (`PgTable | EntitySource`) to the entity: an
  `EntitySource`, or an extension built by `defineExtension` (the source of `from: <shape>`
  collections). A raw `pgTable` no longer type-checks as `from`. This covers the
  single-table window, lookup and `all` forms (`serve-collection.ts`, `serve-all.ts`) and the
  union arms (`serve-union.ts`). Sites that pass `entity.table` (`_tasks`, `_attempts`,
  `_browserBookmarks`, …) pass the entity itself. `joins` are unchanged.
- **Bind assert (rung 4, fires at server boot and in every test that serves).** The served
  entity's name must equal the collection's `from` (the ref's name, or the extension shape's
  table). The message names both, for example: *"collection `pushes` reads entity `pushes`
  but is not `from` it — pick its fields (`from: pushesRef, pick: […]`); own `fields` are
  only for what the collection computes."* This sits beside the existing `exposes.base`
  name assert (`exposure-folds.ts:55`). Doing it at type level would need `LiveCollection`
  to carry `from` as a type parameter, which every consumer would have to thread through.
  It is not worth that, and the assert covers every served collection on boot.
- External serves (browser server, demo packs) have no table and are unaffected. Union
  collections keep their own `fields` (`arms` forbids `from`), and each arm's table is
  checked against its `liveArm` ref.
- **Conversions this forces:**
  - The 5 own-field collections over entity tables become `from: <ref>, pick: […]`, keeping
    only computed fields as own fields.
  - Queue ranks become `from: queueShape` with `carry.pick`. `rank` stays an own carry
    field, `rankValueField()`, because it decodes the stored key. This is the `page_blocks`
    precedent: an own field may decode a column, it may not restate one.
  - The 3 raw tables (`pending_questions`, `conversation_turns`, `usage_stats`) become
    `entityRef` + `defineEntity`, with no migration. Turn-ledger's `deriveUpdatedAt` moves to
    `meta.updatedAt`.
  - The boot assert doubles as the census: any site the exploration missed fails the
    build loudly.

### C. A DataView over DB rows cannot take hand `fields` (rung 2)

- `DataViewLiveOrigin` (`data-view/core/internal/types.ts:1569`) and the in-memory
  `{ collection }` arm get `fields?: never`. The base-props `fields?` moves onto the one arm
  that takes it (`{ collection?: undefined; fields }`). The runtime throw in `listSchema`
  for `fields` beside a collection then becomes unreachable, so it is deleted together with
  its test (`derived-fields.test.ts:472`).
- **Rows that come from a collection carry a phantom brand.** In `network/live/core`,
  declare `declare const collectionRow: unique symbol` and
  `type CollectionRow<Row> = Row & { readonly [collectionRow]?: true }`. `useLive`'s
  collection reads (window, `{ ids }`) and `useLiveRow` return `CollectionRow<Row>`. The
  property is optional, so it is assignable everywhere a `Row` is expected and changes
  nothing at runtime. The hand-`fields` arm types `rows` as
  `readonly (TRow & { readonly [collectionRow]?: never })[]`, so rows read from a
  collection, or spread from them, are a tsc error there. The fix the doc names:
  `collection=` + `overrides` / `extraFields`. Nested values (a row's JSON samples, as in
  slow-op detail) are not branded and stay allowed.
- Add a type test with `@ts-expect-error` cases for all three shapes. It goes in
  data-view's `__tests__` and in network/live.

### D. Docs, track

- Rewrite the rules in `network/live/CLAUDE.md` ("a served collection is `from` the entity it
  reads"), `infra/entities` CLAUDE.md (ref-only) and `data-view/CLAUDE.md` (no hand `fields`
  over collection rows). Add an Outcome section to this doc.
- Track page: tick [Guard], set the status to Done (tag), add a status line for the
  2026-10-18 guard, and link this doc. Non-DB lists stay out of scope, as already stated
  there. Since the track closes, no follow-up task is filed unless the outcome turns up one.

## Critical files

- `plugins/infra/plugins/entities/server/internal/define-entity.ts`, `…/types.ts`
- `plugins/network/plugins/live/server/internal/{collection-source,serve-collection,serve-all,serve-union,exposure-folds}.ts`
- `plugins/network/plugins/live/web/internal/use-live.ts`, `core/internal/live-collection.ts` (brand)
- `plugins/primitives/plugins/data-view/core/internal/types.ts`, `web/internal/derived-fields.tsx`
- Call sites: `tasks/tasks-core`, `apps/mail/mail-core` + `reading-pane`, `apps/browser/bookmarks`,
  `conversations/{summary,session-chain,question-relay,turn-ledger,conversations-view/queue}`,
  `page/tags`, `plugin-meta/plugin-health`, `apps/events/events-core`, `apps/sonata/track-mixer`,
  `primitives/usage-rank`
- Static readers: `database/change-feed/check/producer-writes.ts`, `plugin-meta/facets/db-schema/facet/index.ts`

## Verification

- `./singularity build`: it must generate **no migration**, and boot must not throw (the bind
  assert passes on every served collection).
- `./singularity check`: type-check, `plugins-doc-in-sync`, change-feed producer-writes,
  db-schema facet.
- `./singularity test` on `infra/entities`, `network/live`, `primitives/data-view`,
  `database/change-feed`, and the converted plugins (row oracles).
- Negative proof: the type tests' `@ts-expect-error` cases, plus a temporary
  `serveCollection` of an own-fields collection over an entity, which must throw at boot.
  The latter is not committed; it is replaced by a unit test in network/live.
- Open the touched surfaces in the app with `browser_*`: mail reading pane, bookmarks,
  conversation summaries, task pushes, the conversations queue order, plugin health. Each
  must load with no console errors.

## Outcome (2026-10-18)

Built and deployed. The build generated **no migration**, and every check passes.

**A — `defineEntity` takes only a ref.** The string-name overloads and the string branch are gone. 19 call sites moved to `entityRef` in core. They are tasks-core ×3, summary, session-chain, page tags, plugin-health, mail-core ×8, bookmarks, `event_source_run_events` and sonata track-mixer. `defineExtension`'s internal call moved too. Former `meta.serverOnly` columns are now the `serverFields` argument (page tags' `nameKey`, track-mixer's timestamps, extension shapes' server-only fields). The change-feed `producer-writes` reader and the db-schema facet now resolve tables through ref bindings only. Some server-only columns now sit last, for example `page_tags.name_key` and a few extension columns. drizzle-kit diffs columns by name, so the build generated no migration for the reorder. A fresh database gets the new column order.

**B — a served collection reads the entity it is `from`.**
- **Type error.** `serveCollection`'s `from` is a `ServedSource`: an Entity, an extension handle, or the table `defineEntity` built. The table carries the type-only brand `EntityTable` (entities/server). A raw `pgTable` no longer compiles.
- **Boot error.** `assertServesItsRows` checks the collection's new `rowsFrom` (its declared `from`) against the table it reads. An entity ref must match by name. An extension shape must match the served extension's wire schema, by identity. A collection with no `from` throws.
- **Union arms.** `served.arm` takes an `EntityTable` and throws unless `liveArm({ from })` names it.
- **Test derivations.** `compileCollection` and `compileUnion` still take any table.

The boot check found every remaining case:
- **Restated their entity's fields:** pushes, bookmarks, conversation summaries, plugin-health reviews, the mail reading pane, `page.block-locations`, `page-tags.vocabulary` and `page-links.sources`.
- **Shape restated:** queue ranks restated its extension shape. It is now `from: queueShape`. A shape's column may be decoded by `carry.fields` (`rank` → `rankValueField`), so the row type is the shape's row with those keys replaced.
- **Raw tables, now entities:** `pending_questions`, `conversation_turns` (whose `deriveUpdatedAt` became `meta.updatedAt`), `usage_stats`, `conversation_categories` and `page_block_docs`.

Collections whose wire rows were pinned keep them with `baseExposures: false`.

**`page_block_docs` needed a `bytes` field type** (decided with the user). Its `state` is a `bytea` whose wire form is base64, and entities assumed the stored row equals the wire row. The fix:
- `fields/core` gains a type-only `StoredAs<S>` / `InferStoredValue<F>`.
- `EntityColumns` types each column by what it stores.
- `Fields.Storage` gains a third arm, `stored`: a column that declares its wire form with sql-column `withWire`.
- The new `fields/bytes` plugin provides the identity, `bytesField()` (base64 `string` value, `StoredAs<Uint8Array>`) and its storage. The storage is the `bytea` column and `bytesToBase64`, which moved out of `collab-doc`.
- `collab-doc`'s server barrel is deleted. editor-collab's table is `defineEntity(pageBlockDocsEntityRef)`.

**C — a DataView over DB rows cannot take `fields`.**
- The live origin and the in-memory `collection` arm declare `fields?: never`.
- `useLive` / `useLiveRow` return `CollectionRow<Row>`, an optional type-only key that a spread keeps.
- The hand-`fields` arm types its rows as `NotCollectionRow`.
- `listSchema`'s runtime throw stays as a backstop for casts.
- Pinned by `data-view/core/internal/data-origin-types.test.ts` and `web/internal/body-types.test.ts`.

**Findings**
- `./singularity build` generates migrations, and loads every `tables.ts`, before it regenerates `fields/server-capabilities-loader`'s `eager.generated.ts`. So a new field type's storage cannot be used in the build that adds it. I added the generated line by hand, and `fields-eager-in-sync` agrees with it.
- turn-ledger's wire `id` is now the branded `TurnId`. It was `string`.
- usage-rank's `useCount` is an int field. It was a float over an integer column.

**Verification**
- `./singularity build` passed every check, including type-check.
- The tests of every touched plugin pass: 668 vitest tests and the bun suites. One fixture in `define-extension-join.test.ts` named its test extension `origin`. That collided with the real `tasks_ext_origin` in the process-wide derived-updatedAt registry, but only when tasks-core ran in the same process. It is renamed `probe_origin`.
- In the app, the agent manager (queue order and pin, a conversation) and a page (text from `page_block_docs`, sidebar tags and backlinks) load with no console errors.
- Not verified: the mail reading pane (no Gmail access in this worktree) and bookmarks.
