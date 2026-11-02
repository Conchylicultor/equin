# Resources track [12] session 3: composite-key collections

- Track: Network Layer › Resources (`block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`), item [12], session 3.
- Design parent: `2026-10-19-global-live-compiled-narrowing.md` §D. This doc refines §D and supersedes its trigger half (see Decisions).
- Sessions 1 and 2 are on main (`c4afec6024`, `d61bf93e4f`). Measurement method: `2026-10-24-global-live-narrowed-reads.md` (§Measurement, §Baseline).

## Context

### The problem

Five live **values** read tables whose primary key is composite. Each one declares a whole-table `reads`, so every write to the table recomputes every subscribed tuple:

| value | table | pk |
|---|---|---|
| `data-view-row-order` | `data_view_row_order` | `(data_view_id, view_id, row_key)` |
| `data-view-custom-values` | `data_view_custom_values` | `(data_view_id, row_key, column_id)` |
| `active-data.bindings` | `active_data_bindings` | `(conversation_id, message_id, tag, occurrence_index)` |
| `sonata-track-view` | `sonata_track_view` | `(song_id, track_id)` |
| `agent-notes-authors` | `page_blocks_agent_authors` | `(block_id, conversation_id)` |

### Why they cannot narrow today

Narrowing to rows may only come from a compiled query, and a collection's identity is one column:

- `singlePrimary` and `tablePrimary` reject a composite pk.
- `LiveCollectionSpec.id` is a single field.
- `HostMap` carries one `column`.
- The trigger fills `ids` only for a single pk.

### What we want

Each value becomes a by-scoped `all` collection with a composite id. Then:

- **A write to another scope costs 0 loads.**
- **A write to the held scope** refills only the changed rows and ships a keyed delta.

### Also in this session (decided 2026-11-02)

- **The other 14 reasons.** 14 other values carry the reason "whole-table until it reads through a collection".
  - The honestly whole-table ones get a reason that says why.
  - The ~9 migratable ones get a reason that names their follow-up task.
- **The session-adoption fix (open from session 2).** Recording a session costs 2 loads, because adoption commits its two writes in two transactions. It moves to one transaction.

## Facts verified in code

- **The scope already works for composite tables.**
  - `scopeOf` (`query-resource/server/internal/compile-alias.ts:745`) emits `eq(col, $param)` and a `match` on carried columns, independent of pk shape.
  - `resolveLayout` (`change-feed/server/internal/triggers.ts:~571`) installs `carry` whatever the pk; only the `unchanged` gate needs a single pk.
  - The routed trigger emits row-aligned `keys` over old ∪ new for every carried column.
  - So a composite table can already carry all its pk parts, row-aligned, with no SQL change (the rest is decided below).
- **Ids are strings end to end.**
  - Client `keyOf` (`pkKeyOf`, `network/live/core/internal/window-descriptor.ts:62`) is `String(row[id])`.
  - The server key is `keyField` / `__id`; the runtime uses only `keyOf`.
  - Point sets are comma-joined (`isPointId` rejects `,`).
- **Where one id column is assumed:**
  - query-resource: `resolveIdentity`, `tablePrimary` (6 callers), `compileAllCollection` (`sameColumn(keyRead, pk)`, the order tiebreaker, `hostIn(pk)` via `anyOf`, `orderIdsSql … AS __id`, `followablePoint`).
  - network/live: `LiveCollectionSpec.id`, `rowsPart`, `serve-collection.ts` (539-553, 815, 1005, 1049).
  - resource-runtime: `HostMap` / `valuesOf` / `tableLayoutRequirements` (`core/routing.ts`).
- **No codec exists yet.** The precedent is `armKeyCodec` (`query-resource/core/internal/arm-key.ts`).
- **No overlay merges into any of the five payloads.**
  - Sonata only orders its writes through `enqueueDetachedWrite` / `enqueueResourceWrite(trackViews, { songId })` send-order lanes.
  - agent-notes authors have no HTTP writer (`recordAgentNotesAuthor`, MCP page tools only).
- **The adoption writes:**
  - The reconciler's `apply()` (`conversations/server/internal/status-reconciler.ts:~335`, `:361-366`) runs `updateConversation(id, patch)` (no executor) and then `recordSessionId(id, sid)` (takes `conn`).
  - That is two implicit transactions, so two change-feed bursts and two drains.
  - The narrowing fixture's `record-session` (`debug/plugins/read-set/server/internal/narrowing-fixture.ts:54-65`) copies the same sequence.

## Decisions

1. **Composite id = one codec, one object.** It is declared on the collection, and every key site derives from it. Client `keyOf`, server `keyField` / `__id` / order ids, point encode and decode, and the refill decode all take it, so they cannot disagree (fix ladder rung 1).
2. **Per-row routing comes from carried columns, not the trigger's `ids`.**
   - The identity route lists the pk parts.
   - `tableLayoutRequirements` carries them all.
   - `valuesOf` rebuilds each changed row's id from row-aligned `keys`.
   - **No trigger SQL change**: the shared-layer fingerprint and the single-pk golden stay as they are.
   - §D's trigger pairing (`TG_ARGV` as a list, `unchanged` for composite pks) is dropped. It would add only `unchanged` gating, and none of the five tables does no-op UPDATEs:
     - row order upserts `WHERE rank IS DISTINCT`;
     - authors insert `DO NOTHING`;
     - the rest are real changes.
   - Reopen it only if a measurement shows otherwise.
3. **Composite ids only on `all` collections.** Windows, unions, lookups, joins and `follows` over a composite pk are refused at compile time, with a message naming `all`. `:rows` stays, because `compileAllCollection` requires its contract.
4. **Keys are renamed, not proved** (C39): each key gets `.v2`, the page-blocks precedent. An old tab is refused as skew instead of mis-merging deltas.
5. **Rejected: "composite key for the diff only, routed per scope"**, which skips step 4 below.
   - It meets the unrelated-scope target.
   - But every in-scope write would refill the whole scope. For row order or custom values on a large view, that is one drag or one cell edit reloading thousands of rows.

## Design

### 1. Codec: `query-resource/core/internal/composite-key.ts` (public via `core`)

```ts
export const bindingKey = compositeKey(["conversationId", "messageId", "tag", "occurrenceIndex"]);
// bindingKey.encode(row) → "conv-1%2Fx/msg-2/go/0"   bindingKey.decode(id) → string[] | null
```

- **Encoding.** Each part is `encodeURIComponent`'d with `,` forced to `%2C`, and parts are joined with `/`. So `isPointId(encode(row))` always holds.
- **`decode`.** Strict: it returns `null` on a wrong part count or a bad escape, and never throws.
- **Refused at construction:** fewer than 2 fields, a duplicate field, or more than 8 fields.
- **Part columns.** Each part must be a text, uuid or integer column. The server checks every part's canonical text with `canonicalTextOf`, the same rule as `scopeOf`.

### 2. network/live

- **The id field accepts the codec.** `LiveCollectionSpec.id` becomes `(keyof Row & string) | CompositeKey<keyof Row & string>`, at `live-collection.ts:219`, `:428` and `:558`.
- **One key reader.** `pkKeyOf` becomes `idKeyOf(id)`, used by `rowsPart` and every `keyOf`.
- **Serving.** `serve-collection.ts` binds each part to a base column, and refuses a composite id on a window, a union or `withWire`.
- **Preload.** A by-scoped set already refuses `preload`, and that stays.

### 3. query-resource

- **Pk columns.** Add `tablePrimaryColumns(table)` in `routes.ts`, returning the ordered pk list. For a composite pk, `baseIdentityRoute` emits `{ kind: "identity", columns }`.
- **`compileAllCollection`:**
  - Each id part must be `sameColumn` with its pk column, in order.
  - The tiebreaker is every pk column, ascending.
  - `orderIdsSql` selects the parts, and JS encodes them into `__id`.
  - A refill decodes the ids and checks each part. An id that fails is absent, never an error.
  - The refill renders a new `hostInTuple(cols, tuples)` in `raw-sql.ts`: `(a, b) IN (VALUES ($1::t, $2::t), …)`, chunked like `anyOf`.
- **Refusals.** The other `tablePrimary` callers (`compile-lookup`, `compile-union-window`, `grouped`, `joins`) and `followablePoint` refuse a composite pk, with a message naming `all`.

### 4. resource-runtime (`core/routing.ts`)

- **`HostMap` identity gains `columns?: readonly string[]` plus the codec's `encodeParts`.** The runtime asserts that `columns` and `column` are never both set.
- **`valuesOf`.** With `columns` and known rows, it builds each selected row's tuple from `change.keys` and encodes it.
  - A missing carried column or a null part means FULL.
  - Over the 7000-byte cap, `keys` is dropped, so the result is FULL with no new code.
- **`tableLayoutRequirements`** carries every column in `columns`.

### 5. The five migrations: one commit each, smallest first

| new key | scope `by` | order | consumer change |
|---|---|---|---|
| `agent-notes-authors.v2` | `blockId` | `createdAt, conversationId` (`useAgentNotesCreator` = `[0]` relies on it) | `useAgentNotesAuthors` reads `useLive(c, { where })`. |
| `active-data.bindings.v2` | `conversationId` | pk | `useActiveDataBinding` keeps `.find` and `safeParse` (the `payload` jsonb stays undecoded). |
| `sonata-track-view.v2` | `songId` | pk | The observer reads `useLive(c, { where: { songId: songIdKind.key(songId) } })`. **Check first** that `songIdKind.key` is the column's canonical text (`legacyBareUuid`, `seed` alias). Both lanes go through `resolveOptimisticSource`'s scoped form. |
| `data-view-row-order.v2` | `dataViewId, viewId` | `rank` (check `rankText` is a plain text column, C collation), then pk | `useRowOrder` keeps the `Map<rowKey, Rank>` projection and its pending/settled union. |
| `data-view-custom-values.v2` | `dataViewId` | pk | `useCustomColumnValues` keeps its nested-map projection. |

For each migration:

1. Replace the `liveValue` and `serveValue` with `liveCollection` + `serveCollection` (`from` the table, `all: { by, orderBy, unbounded: { reason } }`), and delete the whole-table reason.
2. Add an old-tab-refused web test, shaped like `page/plugins/editor/web/__tests__/page-blocks-old-tab.test.ts`.
3. Add a DB oracle, shaped like `serve-collection-all-scoped-oracle`, with a composite fixture. It covers insert, update, delete, and moving a row across scopes (a delete plus an insert).
4. Update the plugin's CLAUDE.md. Today it says "a value, not a collection: the composite key has no single id".

### 6. The 14 other reasons

Each value's reason is rewritten in place. One commit covers all of them, and no behaviour changes.

- **Honestly whole-table:** search.results, chord.progress, report-investigations.scope, page.backlinks (chip titles fan out to any referent table) and mail-labels (one account's list).
  - Each reason says why the whole table is read.
  - The phrase "until it reads through a collection" is removed.
- **Migratable** (follows or a scoped `all`): attachments.file, history.version, deploy.server-ssh-key, task-source-url, mail.message-body, task-subject, attachments.by-owner, events.run-events, and claude-cli.calls-for (its calls arm only).
  - Each reason names its follow-up task, which is the next main task filed at the end.

Afterwards, `rg "until it reads through a collection" plugins` finds nothing.

### 7. Session adoption: one transaction

1. **Executor.** `updateConversation(id, patch, exec = db)` (`tasks-core/server/internal/mutations/conversations.ts:185`) threads `exec` into `conversationContext`, `withTaskStatusChange` and the update. `insertConversation` already has this shape, and `DbExecutor` lives in `status-batch.ts`.
2. **Emit after commit.** When `exec` is a transaction, the emit must not run inside it. Two options:
   - return the emit as a thunk the caller runs after commit;
   - reuse `withTaskStatusBatch` / `runStatusBatchOn`, which already defer to commit. Read that path and pick it if it fits.
3. **Reconciler `apply()`.** When `plan.adoptedSessionId` is set, it runs in one `db.transaction`:
   - `updateConversation(…, tx)`, then `recordSessionId(id, sid, tx)`. Widen `conn` to `DbExecutor`.
   - After commit: the emit, then `refreshConversationChain`, then the `deliverHeldTurnsJob` enqueue.
   - One append per transaction keeps `seenAt` (transaction start) unique per conversation. Say so in the comment.
4. **Fixture.** The narrowing fixture's `record-session` makes the same two writes in one transaction.

## Measurement (`plugins/network/plugins/live/e2e/narrowing.ts`, extended)

**Order of work.**
- Add the new subscriptions and phases first.
- Run the **baseline** on a build of this branch that has the script and fixture only, with exactly the session 2 command line plus the new flags.
- Run **after** on the final build.
- Report medians of 3 runs (`--runs 3`).

**Subscriptions.** Each value's tuple is held on scope X; the old key goes in the baseline, the `.v2` key after. A `--composite-keys old|v2` flag picks them through the core descriptors.
- row order `{dv, viewA}`
- custom values `{dvA}`
- bindings `{convC}`
- track view `{songS}`
- authors `{blockB}`

**Fixture actions** (new; under the read-set fixture's main-refusal):
- `stamp-agent-author {blockId, conversationId}`, calling `recordAgentNotesAuthor` (there is no HTTP writer).
- Clean-up actions for every row the script writes.
- Row order, custom values, bindings and track view use their real endpoints, on synthetic scopes the script creates. A song for the track view: use a fixture-created song, if the FK allows it.

**Phases**, 10 writes each:

| kind | phase | expected after |
|---|---|---|
| unrelated | row order on `{dv, viewB}` | 0 loads, 0 frames on every key |
| unrelated | custom value on `dvB` | 0 / 0 |
| unrelated | binding on another conversation | 0 / 0 |
| unrelated | track view on another song | 0 / 0 |
| unrelated | author stamp on another block | 0 / 0 |
| related | the same five writes on the held scopes | 1 load per write, frames = keyed deltas of about one row (chars recorded, against the baseline's whole-payload frames) |
| session 2 | record-session on F | **2 → 1** load per transcript key of F, 0 for C |

**Reported per key and phase:** Δloads (by parent), Δfeed, frames by kind, chars, `ackOverflows`, `routeDrifted`.

## Tests

- **query-resource:**
  - `composite-key.test.ts`: round trip with `,`, `/`, `%`, `%2C`, unicode and empty parts; `isPointId` always holds; a foreign string decodes to `null`.
  - `routes.test.ts` and `compile-alias-scope.test.ts`: the composite identity route lists its columns; the refusals; `hostInTuple`.
  - `identity.test.ts`: the composite refusal's message is updated.
  - A scoped oracle over a composite fixture: refilling the ids equals a filtered full recompute.
- **network/live:** declaration refusals (window, union, `withWire`); the client key equals the server key for an adversarial row.
- **resource-runtime:**
  - `routing-layout.test.ts`: every part is carried.
  - `runtime-table-routing.test.ts` (the composite fixture at about line 1531): row-wise tuples; a missing column goes FULL; over the cap goes FULL; a scope move names both scopes.
- **change-feed:** `routed-trigger.test.ts` covers a composite table carrying every pk part, row-aligned over old ∪ new. That is the load-bearing assumption of Decision 2.
- **Per plugin:** each value's oracle and old-tab test; sonata's lanes through the scoped form (`optimistic-mutation` tests).
- **Adoption:**
  - When `recordSessionId` throws inside the transaction, the tail is not left changed.
  - No emit fires on a rollback.
  - `record.test.ts` stays green.
- **How to run:** `./equin test <each touched plugin>`, then `./equin check`, then `./equin build`.

## Docs and track

- This doc gets "As landed" plus the numbers.
- `2026-10-19-…-compiled-narrowing.md` §D gets a pointer here.
- Update the CLAUDE.md of network/live, query-resource, resource-runtime and the five plugins.
- On the track page (once the equin MCP is reachable again):
  - set [12] session 3 to `[x]`, with the before/after table;
  - rewrite the header's "What is left" item 1 and its "Next step".
- File one next-main task: the migratable values' follow / scoped pass, with the page id and the Track Instructions id.

## Risks

- **Non-canonical part text** (an uppercase uuid, `007`, the sonata `seed` alias) would mean SQL equality and the router's string match disagree. Scope params are already checked by `validateParams`, and refill parts by `canonicalTextOf`. Sonata is checked before it migrates.
- **Bulk statements over the 7000-byte cap go FULL.** That is sound and counted. The likeliest trigger is custom values' `delete-column` across a large surface.
- **`:rows` point descriptors for the five are registry surface nobody reads yet.** That is accepted, because the `all` compile requires them.
- **Moving the emit after commit** could change event order for listeners of `emitConversationStatusChange` versus `deliverHeldTurnsJob`. Keep today's relative order: emit before enqueue.

## As landed (2026-11-02)

All five values are scoped collections over their tables' composite primary keys, under new keys:

| key | scope `by` | id (`compositeKey`) | order |
|---|---|---|---|
| `agent-notes-authors.v2` | `blockId` | `blockId, conversationId` | `createdAt, conversationId` |
| `active-data.bindings.v2` | `conversationId` | `conversationId, messageId, tag, occurrenceIndex` | `messageId, tag, occurrenceIndex` |
| `sonata-track-view.v2` | `songId` | `songId, trackId` | `trackId` |
| `data-view-row-order.v2` | `dataViewId, viewId` | `dataViewId, viewId, rowKey` | `rank, rowKey` |
| `data-view-custom-values.v2` | `dataViewId` | `dataViewId, rowKey, columnId` | `rowKey, columnId` |

- **One codec** (`query-resource/core/internal/composite-key.ts`): `compositeKey([...fields])` encodes each part with `encodeURIComponent` and joins them with `/`. Decoding is strict and canonical: it refuses a foreign or non-canonical spelling (`null`). An integer part is its decimal text, which is what Postgres's `int::text` carries. Client `keyOf`, the server's ids, `:rows` ids and the refill decode all derive from this one codec.
- **Routing without trigger changes.** A composite identity route lists its pk columns. `routing.ts`'s `composedValuesOf` composes each changed row's id from the `keys` the feed already carries, row-aligned over old ∪ new. A missing key column, a NULL part or keys over the NOTIFY cap go FULL.
- **The compiler** (`compile-alias.ts`) checks the following:
  - the key fields are the table's pk columns, in order;
  - every pk column breaks ties;
  - the refill is `(c1,…,cn) IN (SELECT * FROM unnest($1::t1[],…))` (`raw-sql.ts`'s `tupleIn`), with each part's canonical text checked in JS.
  - It refuses joins, families and groups on a composite set. `followable.rows` is `null` for one: a composite set is followed by scope only.
- **The declaration.** A composite id is allowed only on an `all` collection, and `by` may not name every part. `liveCollection`'s first overload now infers `const I`, so `c.id` keeps its literal type.
- **Old tabs.** Each value has its own `*-old-tab.test.ts`. They prove that the old non-keyed read throws "no keyOf registered" on the first keyed delta. That is why every key was renamed.
- **Bindings are read per widget.** A widget reads its own binding row by its composite id, `useLive(activeDataBindings, { id: identity ? activeDataBindingKey.encode(identity) : null })`, a `:rows` point read. A legacy log's widget has no identity: a `null` id is the row read's native skip. A write to another widget's binding reaches nothing. The conversation scope `{ where: { conversationId } }` stays the read for a whole-conversation reader, and it is what the measurement holds.
  - This replaces a scoped-set `null` skip that a first draft added. Upstream's one-read-hook rework (`3e1dbc9b22`) keeps `null` as a count's skip only, and the row read already has one.
- **Session adoption** is now one commit. `updateConversation(id, patch, { alongside })` runs the patch and the `alongside` write in one `db.transaction`. The task-status emits ride that transaction (`withTaskStatusChange`'s tx path), and the conversation status event goes out after commit. The reconciler passes `recordSessionId(id, sid, tx)` as `alongside`, and the narrowing fixture's `record-session` does the same.
- **The 14 reasons.**
  - Five are rewritten as honestly whole-table: search.results, chord.progress, report-investigations.scope, page.backlinks and mail-labels.
  - Nine name the follow-up task (`task-1793650999-1nff0e`): attachments.file, history.version, deploy.server-ssh-key, mail.message-body, task-subject, task-source-url, attachments.by-owner, events.run-events and claude-cli.calls-for.
  - `rg "until it reads through a collection" plugins` is empty.

### Deviations from the plan

- **Entity conversions.** Four of the five tables were raw `pgTable`s, and `serveCollection`'s `from` must be an entity. Each migration first converted its table to `defineEntity` from one field record in `core/`. The DDL is unchanged (`migrations-in-sync` reports ok, and no migration was generated). Sonata's table was already an entity.
- **One generic DB oracle instead of five per-plugin oracles.** `network/live/server/internal/serve-collection-all-composite-oracle.test.ts` covers insert, update, delete and a scope move on a three-part composite table, through the real change feed. Each plugin has an old-tab test instead of its own oracle.
  - Trade-off: a plugin-specific mistake is not pinned per plugin. Examples are a wrong `by`, or a part whose stored text is not canonical.
  - The compiler's checks and the per-plugin old-tab tests narrow that gap.
  - The after-measurement below runs all five values on the deployed build.
- **Sonata's scope.** `trackViewScope(songId)` keys the song id with `songIdKind.key`, the same way the routes key it. The read and both send lanes use it.
- **No rollback test for the adoption transaction.** `updateConversation` writes through the global `db`, so a throwing `alongside` cannot be driven on a throwaway database without new injection. The rollback holds by construction: both writes run inside one `db.transaction`.

### Numbers (`narrowing.ts --suite composite`, medians of 3 runs, 10 writes per phase)

Baseline: old keys on a build with only the script and fixture added. After: `--composite-keys v2` on the final build. Logs are in `/tmp/composite-draft/{baseline-old-keys,after-v2}.log`.

| phase (10 writes) | key | loads before → after | frames before → after | chars before → after |
|---|---|---|---|---|
| row order, another view | row order | 10 → **0** | 0 → 0 | 0 → 0 |
| custom value, another data view | custom values | 10 → **0** | 0 → 0 | 0 → 0 |
| binding, another conversation | bindings | 10 → **0** | 0 → 0 | 0 → 0 |
| track view, another song | track view | 10 → **0** | 0 → 0 | 0 → 0 |
| author stamp, another block | authors | 10 → **0** | 0 → 0 | 0 → 0 |
| row order, held view | row order | 10 → 10 | update×10 → delta×10 | 3178 → 4330 |
| custom value, held data view | custom values | 10 → 10 | update×10 → delta×10 | 3328 → 4402 |
| binding, held conversation | bindings | 10 → 10 | update×10 → delta×10 | 3530 → 4620 |
| track view, held song | track view | 10 → 10 | update×10 → delta×10 | 3925 → 4486 |
| author stamp, held block | authors | 10 → 10 | update×10 → delta×10 | 12145 → 11194 |
| record-session F | each of the 7 transcript keys | 2 → **1** | — | — |

- **Unrelated writes no longer reach the five values.** Before, every write to one of the five tables reloaded every subscribed tuple of that table, and each reload diffed to nothing. After, the router skips the write on the carried scope column: 0 loads.
- **A related write is one load either way.** It is now a one-row refill shipped as a keyed delta, where it was a whole recompute shipped as an `update`.
- **Bytes on the wire: honest regression on tiny scopes.** The fixture scopes hold one or two rows. A keyed delta carries the row, its composite id and the order, so on these scopes it is 15–30% larger than the whole value was. The authors tuple holds a real card's several authors, and there the delta is already 8% smaller. The saving in bytes grows with the scope's size; the saving in loads does not depend on it.
- **Session adoption is one commit.** Each transcript key of F reloads once per adoption instead of twice. `Δfeed` stays at 2: both tables change in that one commit.
