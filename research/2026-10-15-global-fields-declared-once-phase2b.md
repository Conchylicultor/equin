# Fields declared once — Phase 2b: no list declares fields by hand, and `row` is gone

Track page: `block-c8dbdc78-50f1-483a-bfbb-02f24825f9e0` (Design v2: `block-5f372b48-ddc0-4d06-a89b-8b65d44ddef7`).
Track instructions: `block-361815ed-5750-413a-b5ab-31c5dc855144`.
Previous plan: `research/2026-10-13-global-fields-declared-once-phase2.md` (Push 2b, §8).

## Context

Phase 2a moved every DataView over a live collection onto the derived spelling: `from` / `pick` / `related` / `fields` / `carry`. Three things keep track exit criterion 3 (no legacy path, enforced by tsc) open:

1. **58 production `liveCollection` declarations still use `row:`.** None of them is rendered by a DataView: they are lookups, `all` sets and a few windows. There are also **134 test, fixture and golden sites** on the old spelling. While they remain, `row`, `filterable`, the explicit `exposes`, and `collection.fields: null` / `from: null` all survive.
2. **Three lists use per-list `defineFieldExtensions` slots** because their values are not DB data:
   - `HomeApps.Fields`: app usage. The rows are the app registry.
   - `FileBrowserSlots.Fields`: git status. The rows are filesystem entries.
   - `Deployments.Fields`: release state. The rows are a DB collection, but the value comes from per-row live probes.
3. **Runs arm order regressed.** The order build → release → deploy → backup was a committed reorder config of the deleted `Runs.Fields` slot (`config/runs/fields.jsonc`, with a written rationale). Arm sections now follow plugin load order: deploy, backup, build, release.

**Already done:** the fourth item. `resource-runtime/CLAUDE.md:603` and `server-core/CLAUDE.md:48` now cite `LiveColumns.Expose` / `LiveColumns.Scoped`, which both exist (`serve-columns.ts:133-148`). Only a re-grep is needed at the end.

**Exit:** one push.
- `row`, `filterable` and explicit `exposes` are deleted from `liveCollection` (tsc).
- `defineFieldExtensions` is no longer exported. Only the internal `DataViewSlots.FieldExtension` (custom-columns) remains.
- Every in-memory DataView over records names a declaration (a collection or a row kind), not hand `fields`.
- The runs arm order is a committed config again.

## Design

### A. `from` takes any declared field record; no window means no labels

The census (58 sites) splits as follows:

| Kind | Sites | Migration |
|---|---|---|
| Already `fieldsToZodObject(record)` over an entity | 12 (pushes, release.runs, plugin-health, conversation-summaries, mail messages, places ×2, bookmarks, event-sources, boot-trace, trace, slow-op-callers) | `from: entityRef` (+ `pick` for windows) |
| `defineExtensionShape(...).schema` | ~26 (task-track/category/effort/preprompt/title/auto-start, outcome-report, triage, notes, turn-summary, progress, preprompts, sonata modes, rhythm, ug-alignment, health, starred, tag assignments, todo/prompt links, queue ranks, launch decisions, automations.tasks) | `from: shape` |
| Hand `z.object` | ~15 (trash, job-runs, notifications, usage-stats, agents ×2, question-relay, build.history, conversation-categories, page links/block-doc/locations, task-descriptions, attempt-workspaces, debug.traces, op-store ×2) | own `fields:` (+ `from` where an entity exists) |
| `pick`/`extend`/`omit` of an entity schema | attempts, slow-ops ×2, queue-ranks | `from` + `pick` + own `fields` |

**`from` accepts an extension shape.** A shape already is a table's `FieldsRecord` plus its key. Making it a valid `from` (one `FieldOwner` type: `EntityRef | ExtensionShape`) removes ~26 hand restatements. The alternative was minting an `entityRef` per extension. That restates what the shape already declares, so it is rejected.

**Non-window forms need no labels.** A lookup-only or `all` collection has no filter and no window. For it, `from: X` with no `pick` carries every non-`serverOnly` field of X. `pick` / `fields` stay available to narrow it or add fields. Labels (`RequireLabel`) and derived filter domains apply only to window collections, plus whatever a DataView names.

An `all` set that a DataView reads in memory (the Queue pattern) still needs labels. The rule:
- A DataView's `collection` / row-kind prop requires a `Labelled` declaration (tsc).
- A lookup cannot be passed there at all.

**Nested values are `jsonField`s.** `jsonField` gains `FieldMarks`, so a labelled json field can be listed, though it is never filterable (no domain). This covers:
- the attempts' nested `conversations` (a `jsonAgg` server-side);
- `attempt-workspaces`' discriminated `WorkspaceSpecSchema`;
- the op-store `waits` / `steps` / `sleeps` / `openWait`;
- trash `meta` and notifications `metadata` (`z.record`);
- question-relay `questions`;
- agent-launches `latestConversation`;
- job-runs `input` (`z.unknown`).

**Brands come from field factories, not `.extend`.**
- `rankField` decodes through `RankSchema`, the way `idKindField` decodes through `storedIdSchema`. That removes the queue-ranks and agents `.extend`.
- Tolerant models stay `parsedTextField(StoredModelChoiceSchema)`, as they already are on their shapes.

**Deleted (tsc):**
- `LiveRowSchema`, `LiveCollectionSpec`, `LiveArmsSpec`, `LiveNoWindowSpec` / `LiveLookupSpec` / `LiveAllSpec`, and the three old overloads (`live-collection.ts:629-672`);
- `filterable` and explicit `exposes`.

`LiveCollection.fields` / `.from` become non-null. Data-view drops its `fields === null` branches and the "hand `fields` beside a collection" throw: the prop union already excludes that.

**Server:** no change. `serve-collection.ts:547` binds `rowKeys` either way. Every migrated collection keeps its exact `rowKeys` set: carried and listed fields reproduce the old schema's keys. A per-site test asserts it (below).

**Behaviour to watch:** `fieldsToZodObject` backfills a missing key with the field default, where the hand `z.object` rejected it. The server always projects every `rowKey`, so nothing changes on the wire. The parity test pins the key set.

**Tests (134 sites):** port each to the fields spelling. A test that only exercised a deleted path is deleted, with the replacing derived-path test named in the commit:
- reserved `filterable` names;
- old-arm unions;
- explicit `exposes`.

Goldens (`compile-sql-golden.ts`, `compile-union-golden.ts`) are regenerated, and their SQL must be byte-identical.

### B. Row kinds and client fields (Group C)

**A row kind is a collection with no server.** It is declared in `network/live/core` with the same spelling as a no-window collection:

```ts
export const homeApp = rowKind("home.app", {
  fields: { name: textField({ label: "Name", primary: true }), … },
  carry: { fields: { id: textField() } },
  id: "id",
});
```

It carries `key`, `fields: LiveField[]` (labels, options, domains) and `row`, with the same shape data-view already reads from a collection. So:
- `FieldPresentation.Register({ owner: homeApp, … })` presents it with no new owner kind;
- the DataView in-memory origin's `collection` prop accepts `LiveCollection | RowKind`, so there is no new prop;
- the upgrade path (a kind that needs server filtering) is to replace `rowKind(` with `liveCollection(` and add a `serveCollection`, with no consumer change. This gets recorded on the track page.

**Client fields are declared once in core and bound once in web, mirroring `liveArm` / `defineRunKind`:**

```ts
// core: types, labels, options — filter domains for in-memory filtering only
export const appUsageFields = clientFields(homeApp, {
  focusedMs7d: intField({ label: "Focused (7 days)" }), …
});
// web
ClientFields.Resolve({ fields: appUsageFields, useValues: useAppUsageValues });
// useValues: Hook<(rows: readonly Row[]) => ResourceResult<(row: Row) => Values>>
```

- **The owner** is a row kind or a collection. Deployments `release` is a client field on the `deployments` collection.
- **One hook per surface, not per row.**
  - Loading maps to `pending`, an error to `readError`, ready to `value`. These are today's exact semantics, generalized.
  - The file explorer's hook reads its folder context (`useExplorerDir`, `useHomeDir`) as it does now. It returns no fields outside a checkout by answering `null` for every row.
- **Server filtering on a client field is a type error.** Client fields are not in the owner's field ids, so `useLive(…, { where })` cannot name them.
- **Filtering in a DataView:**
  - in-memory origins filter, sort and group them through `matchesFilter`;
  - a live `source` origin shows them but marks them `filterable / sortable / groupable: false`, since the server cannot answer those. None of the three lists is a live source today.
- **Deployments:** `release` needs a batched read of `release.candidate` × `releaseHistory` for every (composition, platform) pair. That replaces the per-row `CandidateProbe` components. Step 0 checks whether `useLive` can read N keys of a keyed value.
  - If it can, the read is used directly.
  - If not, a keys arm is added to `useLive`, per the CLAUDE.md rule that a new read is an option `useLive` reads, never a new hook.
- **Check:** `live:arms-registered` (`live/check/index.ts:244`) extends to "every `clientFields` declaration has exactly one web `ClientFields.Resolve`". This is the same pairing rule as arms.
- **Data-view wiring:** `useDerivedFields` appends client fields after arm fields. Each `useValues` mounts as one nested level, the way `CollectFieldOptions` mounts `useOptions`. `CollectFieldExtensions` then folds only the internal custom-columns slot.

**Per list:**
- **Home:** `homeApp` in `apps-core/app-launcher/core`. Its base fields (today's web `appFields`) move into the declaration, and their cells move to presentation. Usage becomes `clientFields(homeApp, …)` in `app-usage` core.
- **File explorer:** `fileEntry` in `file-explorer/browser/core`, next to `EntryRow`. The hand `fields` at `file-tree.tsx:~330-420` become declaration plus presentation. git becomes `clientFields(fileEntry, { git, changed })` with section "Git".
  - Fields computed from tree context stay in `extraFields`, if any remain after migration.
- **Deployments:** `release` becomes `clientFields(deployments, …)` in `remote-deploy/core`. `DeploymentsListServerIdProvider` is deleted when its only reader goes.

**Deleted:** `HomeApps.Fields`, `FileBrowserSlots.Fields`, `Deployments.Fields`, the `defineFieldExtensions` export (`data-view/web/index.ts:131`) and its public types. The factory stays internal for `DataViewSlots.FieldExtension`.

### C. Runs arm order is the union's committed config again

- **Order source:** the union's presentation supplies it as `FieldPresentation.Register({ owner: runs, arms: { useOrder } })`, a `Hook<() => readonly string[]>`. `deriveFields` orders arm sections by it, and arms it doesn't name append in load order.
- **Where runs gets it:** `Runs.Kind` becomes a reorderable render slot. Runs reads it with `useReorderedEntries`, from a committed config at `config/runs/kind.jsonc`.
  - The file is seeded as build, release, deploy, backup, with the deleted file's rationale restored.
- **Also uses the order:** the kind filter chip options (`useRunKindOptions`), so the chip and the column bands agree.
- **Generic:** any future union gets ordering through the same presentation key; data-view names no arm.

## Steps (one push)

0. Rebase on `origin/main`. Then check three things:
   - whether `useLive` reads N keys of a keyed value;
   - whether `Runs.Kind` can become a render slot (its readers);
   - the `jsonField` `FieldMarks` change against `RequireLabel`.
1. **`fields`:** add `FieldMarks` to `jsonField`; `rankField` decodes `RankSchema`.
2. **`live` core:**
   - `FieldOwner = EntityRef | ExtensionShape` for `from`;
   - a no-window `from` carries everything;
   - labels required on windows only;
   - `rowKind`, `clientFields`;
   - delete the old overloads and types; `fields` / `from` become non-null.
   - Then port the live core / server / web tests and goldens (byte-identical SQL).
3. **Migrate the 58 production declarations**, grouped by owner plugin, using the patterns in §A. Each keeps its `rowKeys` (parity test). This step can be parallelized with Sonnet subagents per plugin group once step 2 lands.
4. **Port the remaining non-live tests:** data-view, optimistic-mutation, resource-vocabulary, codegen, facets, boot-all.
5. **`live` web:**
   - `ClientFields.Resolve`;
   - `arms.useOrder` on `FieldPresentation`;
   - extend the `live:arms-registered` check to client fields.
6. **Data-view:**
   - `collection` accepts a row kind;
   - client-field derivation and value levels;
   - the live-source client-field rule;
   - arm order;
   - un-export `defineFieldExtensions`.
7. **Consumers:**
   - home (row kind + usage);
   - file explorer (row kind + git);
   - deployments (release client field, batched read; delete the probes and the server-id context);
   - runs (reorderable `Runs.Kind`, `config/runs/kind.jsonc`).
8. **Docs:**
   - `live/CLAUDE.md`, the row spelling section (delete it; add row kinds and client fields);
   - `data-view/CLAUDE.md:234, 1843-1856, 2582`;
   - entity-extensions (`from: shape`);
   - the app-cards / deployments / browser docs.
   - Re-grep `LiveColumns.Serve|defineFieldExtensions|row:` in `*.md` outside `research/`.
9. **Finish:**
   - run `./singularity build` (in the background);
   - `./singularity check`, review against the merge-base;
   - update the track page: tick the 2b boxes, record the upgrade path, set the status, mark Phase 2 done;
   - file the Phase 3 (Meta-DataView) task with the page id and `block-361815ed-…`.

## Verification

- **tsc tests:**
  - `row:` / `filterable:` / `exposes:` on `liveCollection` are errors;
  - a window collection with an unlabelled listed field is an error;
  - `useLive(deployments, { where: { release: … } })` is an error;
  - an override id naming a client field of another owner is an error.
- **Parity test:** for each migrated declaration, its `rowKeys` and per-key nullability equal the pre-migration schema. A frozen list is captured before step 3.
- **Unit tests:**
  - row-kind derivation;
  - client-field loading / error / ready mapping to pending / readError / value;
  - in-memory filter and group on a client field;
  - a live source marks client fields unfilterable;
  - arm order with `useOrder` (named, unnamed appended).
- **Goldens:** regenerated with no SQL diff.
- **Oracles:** tree-oracle, all-parity, conversations-oracle, serve-union-oracle, pages-tree-oracle.
- **Checks:** `./singularity check` (type-check, `live:arms-registered`, plugins-doc-in-sync, plugins-registry-in-sync), then `./singularity build`.
- **Screenshots** (`e2e-harness/e2e/screenshot.ts`):
  - the Home app grid table view (usage columns, sort by "Focused (7 days)");
  - the file explorer inside a checkout (git column, filter Changed vs main);
  - the deploy server's deployments (Release column);
  - the runs table field picker (bands build → release → deploy → backup).

## As landed

- **`row` is gone.** All 48 production files and ~70 test files moved to the
  fields spelling. `from` takes an extension shape; about 25 of the sites are
  now a single `from: shape` line. The old overloads and spec types are
  deleted from the barrel, `LiveCollection.fields` is non-null, and an untyped
  `row:` throws.
  - **Deviation from §A:** labels were not relaxed for the forms with no
    window. Unlabelled fields go in `carry`, and `carry` already existed.
  - `jsonField` now has a labelled overload, so a labelled JSON field can be
    listed: `installedApp`'s icon is one.
  - `RankSchema` stayed with `rankValueField`. The queue ranks were not moved
    to `from: queueShape`, because the shape's `rank` field is a plain string.
- **The SQL goldens are byte-identical**, except the L2 `definition` hash of
  the 4 `all` cases. A schema derived from fields backfills defaults, and
  `describeZod` reads that. Each migrated `all` collection's persisted
  snapshot is therefore rebuilt once. The union golden is unchanged.
  - **Behaviour:** a row that is missing a key now gets the field default
    when parsed, where the old schema rejected it. The server always projects
    every row key, so nothing changes on the wire. The `boot-all` fixture now
    uses a value of the wrong type instead.
- **Group C** landed as planned in §B.
  - `installedApp` (app-launcher core) replaces `appFields`.
  - `fileEntry` (browser core) declares `name` and `path`. The tree's other
    columns are computed and stay in `extraFields`.
  - The three client-fields declarations are `appUsageFields`, `gitFields`
    and `releaseFields`.
  - `defineFieldExtensions` and the `fieldExtensions` prop are no longer
    public. The global `DataViewSlots.FieldExtension` slot (custom-columns)
    remains.
  - The `live:client-fields-resolved` check pairs each declaration with its
    resolver.
  - Behaviour changes:
    - Outside a checkout, the git columns exist but are empty.
    - The release column is pending until the server health read lands.
  - The git resolver composes two reads plus a "not a checkout" state, so it
    has a sanctioned `no-handrolled-result` exemption.
- **Deviation from §C, the runs arm order:** each arm states `liveArm({
  order })`, and `runs` core records the rationale. A reorder config would
  have needed `Runs.Kind`, a data slot, to become a render slot. Arm bands and
  the kind filter options both follow `order`.
- **Docs:** resource-runtime and server-core were already correct.
