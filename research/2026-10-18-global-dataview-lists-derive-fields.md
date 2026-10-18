# [Lists]: every DB-backed list derives its fields

Track: "DataView fields everywhere" (page `block-85963184-057d-4983-a5f0-c9183ae8d71c`), item [Lists], exit criterion 3. Follows `research/2026-10-18-page-page-blocks-become-entity.md` ([Entities] done).

## Context

Every table behind a list is now an entity, but most collections over them still restate their fields: own `fields` / `carry.fields` copied from the table's record, or a DataView passing hand `fields`. Labels, options and filterability are therefore declared twice and drift. The goal is that each collection is `from: <entityRef>` + `pick` (list order) + `carry.pick`. Only computed fields, or fields whose list type differs from the stored one, are declared by the collection, and each DataView derives its fields (`source=` or `rows` + `collection=`), saying what it changes in `overrides` / `extraFields`.

## Rules for every conversion

- **Field ids and order do not change.** Saved views and committed `.jsonc` configs store properties by id, and `resources.test.ts` files pin `Object.keys(c.fields)`. `pick` in today's listed order. Where picking would rename an id (backup `archiveSize` vs `archiveSizeBytes`; deployments' `composition` extra field over `compositionId`), keep the collection's own field.
- **List metadata moves onto the entity field**, since it is declared once and every list of the entity shares it: `label`, `primary`, `options` / `optionMeta`, `filterable: false`. `pick` needs a label (`RequireLabel`, tsc). `fieldOverrides` cannot set `options` or `type`, so options live on the field. Dynamic options (a registry, a tag tree) go in a `FieldPresentation.Register` `useOptions`.
- **Entity refs where missing:** `event_emissions`, `claude_cli_calls`, `boot_traces`, `slow_ops`, `slow_op_callers`, `traces`, `places`, `place_tags` and `event_sources` are `defineEntity("name", fields, meta)` with no core ref. Each gets `entityRef(name, fields)` in core and `defineEntity(ref, meta)` server-side, as f20733df64 did, with byte-identical DDL (the build must generate no migration).
- **Type differences stay collection-own:** a stored `rankField` carried as `rankValueField()` (agents); job_runs' float vs int fields; an enum list status over a `text` column (backup arm, unless the entity field becomes the enum).
- **Branded ids:** moving to `from` may type `id` as the entity's `Id<…>` (reports, notifications). Fix the `useLiveRow` callers at the type level; never cast.
- **Wrapper rows** (rows assembled in memory from several reads): if the rows are one collection's rows, pass `rows` + `collection=` (with `hierarchy` for trees, as the pages sidebar does). If they are genuinely client-computed joins (Jobs view, op-status queue, agent launches, sidequest launch list), declare a `rowKind` and pass `collection={rowKind}`, as the app launcher does. Their fields are then declared once by the row kind, not by the DataView. The collection side still moves to `from`.
- **Automation history:** render the tasks collection filtered by the exposed `origin` field rather than joining `{ origin, task }` in memory. Expose `filedAt` (and `role`) from the origin shape if the list needs them.

## Work, by area (disjoint plugin sets)

1. **Debug / infra:**
   - event emissions (`infra/events`, `debug/queue` events view)
   - Claude CLI calls (`infra/claude-cli`, `debug/claude-cli-calls`)
   - boot traces (`debug/boot-profile`, list and lookup)
   - slow ops and callers (`debug/slow-ops`). Its two panes pass hand `fields` beside a live source, which `listSchema` refuses, so this fixes a probable crash.
   - trace events (`debug/trace`)
   - dead jobs and the `jobRuns` collection (`infra/jobs`, `debug/queue`). The Jobs view's merged rows become a `rowKind`.
2. **Runs:**
   - build history (`build`)
   - release history and runs (`release`, studio release history)
   - deploy run history and deployments (`apps/deploy`)
   - backup arm of `runs` (`backup/runs-arm`): `from: backupRunsEntityRef`. The entity's `status` becomes the `BACKUP_RUN_STATUSES` enum, moved to `backup/core`.
3. **Records:**
   - reports (`reports`, `debug/reports`)
   - notifications (`shell/notifications`; its hand `fields` become `overrides`, and the Unread / Read options go on the entity's `read` field)
   - entity versions (`history/engine`, `history/dialog`)
   - trash entries (`infra/trash`, `apps/pages/trash`)
   - agents and agent launches (`conversations/agents`)
   - op-log ops (`debug/profiling/op-log/op-store`, the op-status queue as a `rowKind`)
4. **In-memory lists:**
   - places and place tags (`apps/places`: ref + collection, tags tree via `hierarchy`)
   - event sources (`apps/events`, registry options via presentation)
   - automation history (`tasks/automations`)
   - sidequest launch list (`tasks/sidequest-autopilot`, `rowKind`)

Out of scope: non-DB lists (liveValue, endpoint or config sources) and the [Guard] check.

## Verification

- `./singularity build`: green, with no new migration.
- `./singularity test` on every touched plugin. The pinned `resources.test.ts` field-order tests must pass unchanged.
- Screenshot each touched list to check that it mounts, with the same columns, filters and sections.

## Outcome (2026-10-18)

Done across all four areas, and the build is green with **no migration**. These tables gained a core `entityRef`: `event_emissions`, `claude_cli_calls`, `boot_traces`, `slow_ops`, `slow_op_callers`, `traces`, `places`, `place_tags` and `event_sources`. Every collection over the converted tables is now `from` + `pick` / `carry.pick`. List metadata (labels, options, `primary`, `filterable: false`) moved onto the entity fields.

Departures and findings:

- **Column order:** a collection lists `pick` before its own fields, so a computed field can no longer sit between stored ones. The default order moved in Claude CLI calls (`status` is last), slow ops (`waitMs`), trace events (`incident`, `overBudget`) and Places. Field ids are unchanged, so saved views keep their order. Places and the tag manager keep their old order through `properties` in their committed `.jsonc`.
- **Wrapper rows → `rowKind`:** the Jobs view, the op-status queue and the sidequest launch list. `fieldOverrides(rowKind, …)` types the row as `never`, so row-typed cells on a row kind live in its `FieldPresentation`. A presentation's `header` is only `false`, so a column header that differs from the label stays in `overrides`.
- **Automation history** renders `automationTasks` rows (`rows` + `collection=`), with the task's title and status as `extraFields`. Rendering the tasks collection filtered by `origin` would need `filedAt` / `role` exposed on every task list.
- **`baseExposures: false`** on `agents.roster`, `agent-launches` and the op-store collections keeps their pinned wire rows unchanged. A future exposure of those entities will not fold into these lists until it is dropped.
- **Backup arm:** the entity's `status` is now the `BACKUP_RUN_STATUSES` enum (moved to `backup/core`). `archiveSize` keeps its id as an own field. An arm's `carry` has no `pick`, so `targetResults` is carried as `backupRunFields.targetResults`.
- **`locationField`** now returns a labelled type (`FieldMarks`), as `stringListField` does. `LiveFieldOption` gained `parent?` for nested tag options.
- **Slow-ops panes** passed hand `fields` beside a live source, which `listSchema` refuses. Both now derive their fields.
- **Oracle tests:** a row reaching an entity now carries `$columns`. The release and reports differential oracles compared rows key-order-sensitively, so they now sort keys (`sortedKeys`), as the conversations and source-runs oracles already did. That helper is now copied in four test files.

Not verified: the bell popover and the op-status banner (no op in flight). `build-button.test.tsx` fails on a module mock lacking `FieldPresentation`. Its import chain is unchanged by this work, so the failure appears to predate it.
