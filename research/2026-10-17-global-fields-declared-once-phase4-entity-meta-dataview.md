# Fields declared once — Phase 4: a real Meta-DataView over entities

Track page: `block-c8dbdc78-50f1-483a-bfbb-02f24825f9e0` (Design v2: `block-5f372b48-…`).
Track instructions: `block-361815ed-5750-413a-b5ab-31c5dc855144`.
Previous: `research/2026-10-16-global-fields-declared-once-phase3-meta-dataview.md` (read its "As landed").

## Context

Phase 3 made the union collection the Meta-DataView primitive: shared base fields, per-arm fields in bands, a derived source field, the typed `served.arm` binding with `derive`, entity arms (`liveArm({ from, pick })`) and per-arm row activation. Two gaps remain:

1. **No list mixes ENTITIES.** `runs` is the only union, and its arms are raw ledgers. No production arm uses `from` yet.
2. **An entity arm loses the entity's exposed extension fields.** A task in the task list has Track, Category and Origin. The same task as an arm of a union has none of them. That breaks the track's promise: "a plugin adds a field by extending the entity once, and every list of that entity gets it".

Outcome: a **Recent activity** list (tasks, conversations and pages, newest activity first) on the Home page. It is a plain DataView over a union collection. Each arm carries its entity's picked fields **and every exposed extension field**: Track and Category on tasks, cost and tokens on conversations, Starred and Tags on pages. These filter, sort and group on the server with no list code.

## What exists (from exploration)

**Server union compile** (`network/live/server/internal/serve-union.ts`, `infra/query-resource/server/internal/compile-union-window.ts`):
- Already per arm: `joins?: JoinSpec[]`, `compileJoins`, `routedReads` (alias / reverse routes), typed-NULL targets for arms that lack a column, arm pruning on constants, and `unionRouteId` re-keying (`<kind>.<alias>`).
- `ExtensionJoin` is a `JoinSpec`.
- `exposureFolds` / `exposedBinding` (`server/internal/exposure-folds.ts`) are collection-agnostic.

**Missing:**
- `liveArm` does not keep its `from` entity (`core/internal/live-columns.ts` ~540).
- `compileUnion` fails on an `exposed` owner (`serve-union.ts:~275`).
- `encodeRow` / `readField` know only `$columns[<arm>]`.
- The core codec refuses exposed handles on a union (`query-codec.ts:194-225`: `exposes: []`).
- The union's `groups.query` decodes with no column sets (`serve-union.ts:~565`). So a union cannot group by any arm field today, runs included.
- Web `deriveFields` folds exposures only from `collection.exposes`, which is null on a union (`derived-fields.tsx:~333`).

**Entities:**
- **tasks** and **conversations** are `defineEntity` tables in `tasks-core`.
- **pages** are the raw `_blocks` table (`page/editor/server/internal/tables.ts`) with `pagesEntityRef` (`page/block-entity/core`). A page is `type = 'page' AND deleted_at IS NULL`, and its title is `data->>'title'`.

**`updatedAt`** is trigger-maintained (derived-updated-at) on all three:
- conversations: on status transitions, title and model;
- tasks: on title, description, held/dropped and rank;
- pages: only on rename, move or kind change. Content edits live in the `page_content_edited_at` rollup, which `pageEditedAtSql` reads as `editedAt`.

**No `(updated_at, id)` index** exists on any of the three.

**Exposures today:**
- tasks: `track`, `category`, `origin` (automations);
- conversations: `usage` (cost, tokens, agents);
- pages: `starred`, `origin` (agent-origin presence), `tags`.

`origin` exists on BOTH tasks and pages, so an exposed field's id cannot stay bare in a union (see §1, web).

**Placement:** `Home.Section` (`apps/home/plugins/shell/web/slots`) renders under the app grid of the launcher page. Today its only section is the apps grid.

## Design

### 1. An entity arm carries its entity's exposed fields (network/live)

The arm reaches its `from` entity's exposures with no new spelling, exactly as a direct `liveCollection({ from })` reaches `exposes.base` by default.

**Core:**
- `liveArm` keeps `from` on the handle (`arm.reaches: EntityRef | null`). It is null for a raw-ledger arm and for a shape-`from`, matching `resolveFieldsSpec`.
- The union codec accepts an `exposed` handle when the collection is a union (`arms: true`). In the browser, arms are declared after the union, in other plugins, so the codec cannot know which entities they reach. The server's strict decode over its served handles stays the authority, and a handle that no arm folds is refused there.

**Server (`compileUnion`):**
- At the deferred bind, for each arm with `reaches`, call `exposureFolds({ base: reaches }, b.from, b.joins, LiveColumns.Expose.getContributions(), …)` and append the fold joins to that arm's joins.
- Bind each exposed field with `exposedBinding` (COALESCE to the declared default; presence as `presenceExpr`).
- The exposed set keeps its own identity: owner `{ kind: "exposed", entity }`, set name = slice, wire `<slice>.<field>`.
  - It joins `outerNames`, `filterDecl`, `sortable` (except string arrays) and `wireOwner`.
  - Arms that do not fold it get the existing typed-NULL constant, so a filter `tasks_ext_track.track = 'sidequest'` prunes the conversation and page arms for free.
- `encodeRow` emits `$columns = { [arm]: own, [slice]: {…} }` for each slice that arm folds, and strips every other wire key.
- `readField` resolves through `wireOwner` → `{ set, field }`.
- **Throws:**
  - an entity reached by two arms (one slice would bind two arms, so a filter on "arm A's" track would also filter arm B);
  - a slice named like an arm.
- **Groups:**
  - `groups.query` decodes with the arm and exposed handles, plus a `validateParams` like `serve-collection.ts:~943-1010`.
  - This makes Group by Track work on the union, and Group by `build.status` on runs.
- **Routes:** the extension's `alias` route becomes `<arm>.<slice>` (`unionRouteId`), re-keyed `arm:id` by `encodedMap`. Nothing is new in `query-resource`.

**Web (`data-view` `deriveFields`):**
- For each registered arm with `reaches`, fold the registered exposure owners whose `parent.name` is that entity. Each one is a field with:
  - **id `<arm>.<exposed id>`**, like every arm field, which fixes the tasks/pages `origin` clash;
  - **`section: arm.label`**, so it lands in the arm's band, after its picked fields;
  - **read** guarded by the discriminator: `row[disc] === arm ? columns.read(row)[key] : undefined`. `exposedColumns.read` throws on a missing slice (A16), and that stays true for its own arm's rows;
  - **column**: `columns.column(key)`, with the wire name `<slice>.<field>`;
  - **presentation**: the exposure's existing `FieldPresentation.Register({ owner: shape.exposure })`, so no new registration.

**Docs:** live CLAUDE.md, union section ("an entity arm folds its entity's exposures"), and data-view CLAUDE.md, Meta-DataView section.

### 2. The `activity` union: "Recent activity" (new plugins)

The structure mirrors runs: one union plugin, with each arm living in its domain's plugin (collection-consumer separation, so the union never names an arm).

**`plugins/activity`** (top level, beside `runs`). The **core** declares the collection:

```ts
export const activity = liveCollection("activity", {
  fields: {
    title: textField({ label: "Title", primary: true }),
    type: textField({ label: "Type" }),        // discriminator; options = registered arms
    updatedAt: dateField({ label: "Last activity" }),
    createdAt: dateField({ label: "Created" }),
  },
  carry: { fields: { key: textField(), id: textField() } },
  id: "key",
  arms: { discriminator: "type" },
  sortable: ["type", "title", "updatedAt", "createdAt"],
  default: { orderBy: [["updatedAt", "desc"]], limit: 50 },
  maxLimit: 200,
});
```

- **server:** `activityServed = serveUnionCollection(activity, { derive: { id } })`.
- **web:**
  - `FieldPresentation.Register({ owner: activity })`;
  - `<ActivityDataView>`: a `liveDataSource(activity, { searchable: ["title"] })` in list and table views, with an empty state.

**Arms.** Each arm is a `liveArm({ from, pick })`, and the server binds it through `activityServed.arm`.

| Arm (plugin) | `from` | picks | base binding | `where` | Exposed (free) |
| --- | --- | --- | --- | --- | --- |
| task (`tasks/plugins/activity-arm`), order 10 | `tasksEntityRef` | `author` | `title`, `updatedAt`, `createdAt` columns | — | Track, Category, Origin |
| conversation (`conversations/plugins/activity-arm`), order 20 | `conversationsEntityRef` | `status`, `model`, `kind` | `title` = `coalesce(title, 'Untitled')` | `kind <> 'system'` (as All-conversations) | Cost, Tokens, Agents |
| page (`apps/pages/plugins/activity-arm`), order 30 | `pagesEntityRef` | — | `title` = `data->>'title'`; `updatedAt` = `editedAt` (`pageEditedAtSql` over the `page_content_edited_at` lookup join) | `type = 'page' AND deleted_at IS NULL` | Starred, Origin, Tags |

**Row activation** (`DataViewSlots.CollectionRowActivation({ owner: arm })`, in each arm's web) opens:
- `taskDetailPane` for a task;
- `conversationPane` for a conversation;
- `pageDetailPane` for a page.

Home is not the app that hosts these panes, so the link must navigate cross-app (the tab's `navigate()` from `apps-core/tabs`, or the pane layer's cross-app promote). The first step verifies which applies; if Home cannot host a cross-app link today, that is fixed generically in the activation fold, not per arm.

**Indexes** (migrations via `./singularity build`):
- `tasks (updated_at, id)` and `conversations (updated_at, id)`, so the keyset per arm is index-backed;
- pages sort by an expression and do a bounded full sort over the live pages. This is acceptable at today's size and noted as a risk.

**`apps/home/plugins/recent-activity`:** a `Home.Section({ id: "recent-activity", label: "Recent activity" })` that mounts `<ActivityDataView>` under the app grid.

### 3. Semantics stated (no code)

"Last activity" means each record's own `updatedAt`. A task's does not move while an agent works on it; the agent's conversation row shows that work. A page's is its content `editedAt`, as in the Pages app's Recent pages.

## Steps

1. **Core:**
   - `liveArm` keeps `reaches`;
   - the union codec accepts exposed handles;
   - tests in `live-arms.test.ts` and `query-codec.test.ts`.
2. **Server:**
   - exposure folds per arm in `compileUnion`, and `encodeRow` / `readField` / `wireOwner`;
   - groups decode with column sets;
   - the two throws.
   - Extend `serve-union-entity-arms.test.ts` so its `notes` entity gets an exposed extension. It checks:
     - the fold join is present only in that arm;
     - the alias route is `note.<slice>`;
     - the slice is on note rows and absent on link rows;
     - a filter on it prunes the link arm;
     - a group by it is accepted.
   - Add a **union golden case** with an exposed extension (generator updated; the runs cases stay byte-identical) and an **oracle case** (real triggers): an extension write refills only that arm's row.
3. **Web:**
   - `deriveFields` folds arm exposures (ids `<arm>.<id>`, the band, the guarded read);
   - `derived-fields.test.ts` covers two arms whose entities both expose `origin`.
4. **`activity` plugin and its three arms:**
   - indexes;
   - row activation, with the cross-app verification;
   - the `live:arms-registered` / `live:exposures-registered` checks pass.
5. **Home** `recent-activity` section.
6. **Docs:** live, data-view and the activity CLAUDE.md. Run `./singularity build` to deploy, then verify (below).
7. **Track page:**
   - status;
   - Phase 4 checkbox with sub-items;
   - exit criterion 2 now holds for union lists too;
   - Design v2 §3 annotated in an agent card.
   - File the next main task, with the page id and `block-361815ed-…`. "Plan first."

## Files

- `plugins/network/plugins/live/core/internal/{live-columns.ts,query-codec.ts,live-collection.ts}`
- `plugins/network/plugins/live/server/internal/{serve-union.ts,serve-arm.ts,exposure-folds.ts}`, `server/testing/{compile-union-golden.ts,.json,gen-compile-union-golden.ts}`, `serve-union-oracle.test.ts`, `serve-union-entity-arms.test.ts`
- `plugins/network/plugins/live/check/index.ts` (if arm reach must count as an exposure reader)
- `plugins/primitives/plugins/data-view/web/internal/derived-fields.tsx` (+ test)
- New: `plugins/activity/{core,server,web}`, `plugins/tasks/plugins/activity-arm`, `plugins/conversations/plugins/activity-arm`, `plugins/apps/plugins/pages/plugins/activity-arm`, `plugins/apps/plugins/home/plugins/recent-activity`
- Indexes: `plugins/tasks/plugins/tasks-core/server/internal/tables.ts`
- Reused: `pageEditedAtSql` and the rollup join from `page/editor/server/internal/page-rows.ts` (exported through the editor's server barrel if not already exported)

## Verification

- `./singularity test plugins/network/plugins/live plugins/primitives/plugins/data-view plugins/runs plugins/activity`:
  - the runs union golden is unchanged;
  - the new golden and oracle cases pass.
- `./singularity check`.
- `./singularity build`, then an e2e script `plugins/activity/e2e/recent-activity.ts` on Home:
  - rows of all three types appear, newest first;
  - Type filter options are Task, Conversation, Page, in that order;
  - Filter Track = Sidequest leaves only sidequest tasks, and the request carries a server filter;
  - Group by Type works, and Group by Track works;
  - Starred and Tags appear in the Page band;
  - clicking a task, a conversation and a page opens its pane.
- Screenshot Home (light and dark).
- Runs (`/debug/build`) is unchanged; a group by `build.status` now works.

## Risks

- **Cross-app row activation from Home**: unverified. It is the first thing to check in step 4.
- **Page sort on an expression** (`editedAt`) is not index-backed. If it is slow, fall back to `updatedAt` for the page arm and record that.
- **Codec relaxation**: the browser no longer pre-validates exposed handles on a union. The server stays strict.
- **One entity in two arms** is refused. A union needing that (e.g. "tasks I wrote" and "tasks agents filed" as two arms) would need per-arm slice aliases, which is deferred until such a case exists.

## As landed (2026-10-17)

Deviations from the design above:

- **Page arm's "Last activity" is the page row's `updated_at`, not `editedAt`.**
  `editedAt` reads the `page_content_edited_at` rollup through a `rollup` join,
  which is an `AllJoinSpec` (the `all` compiler's alone). A union arm's joins
  are window `JoinSpec`s, and the rollup table has no trigger (A1), so it
  cannot be a lookup either. So a content edit does not bring a page up.
  Filed as a sidequest (rollup joins on union arms).
- **Task arm picks nothing.** The task entity's `author` has no label, and its
  status is computed over attempts, not a column. The task band is exactly its
  exposures: Track, Category, Origin.
- **Union `title` is nullable** rather than COALESCEd to "Untitled". An
  untitled conversation has no title; a stand-in would be a claim about the
  data.
- **`LiveArm`'s `Pk` default is `string`** (it was `never`). The erased
  spelling `LiveArm<Row, FieldsRecord, string>` (a presentation owner, a
  link's arm) refused any arm that picks, so Phase 3's entity arms could not be
  presented. Fixed at the type, so no call site changes.
- **Groups by a column set.** A union's `:groups` now decodes with its arm and
  exposed sets, and gates params the same way. That also lets runs group by an
  arm field (`build.status`). The union golden changed only by
  `groups.options.validateParams`; the SQL is byte-identical.
- **Data-view server grouping** accepts an arm set's column too (it accepted
  only exposed and own columns).
- **e2e** (`plugins/activity/e2e/recent-activity.ts`) checks rows of every
  kind, the Tasks view, and both cross-app links. It cannot observe the
  subscription frames (the live socket is tab-shared, opened outside the
  page), so the server-side filter and pruning are pinned by
  `serve-union-entity-arms.test.ts`.
- **No new golden / oracle case** for the exposed fold. The compile test
  covers the join, the alias route `<arm>.<slice>`, the folded `$columns`, the
  pruning, the grouping gate and both refusals. The routing machinery is the
  existing arm-agnostic `routedReads` / `compiledUnionRoutePlan`.
