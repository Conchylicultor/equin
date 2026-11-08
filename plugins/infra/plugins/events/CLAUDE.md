# events

## Dangling-binding reconciliation

A trigger binding is a **persisted DB row** (one per subscription, in the
event's `<event_name>_triggers` table), not in-memory state. So a binding can
outlive the code that created it — most dangerously when its target job is
deleted but the row survives. Every emission of that event then tries to
deliver to a job that cannot resolve; pre-fix those threw and
graphile retried each into a dead job (the `improve.apply-queue-top` ×589
retry storm). Two independent layers now make that drift self-correcting, so a
stale binding can never re-accumulate dead jobs:

1. **Boot sweep** — `sweepStaleTriggers()` (in `onReady`) deletes, in one atomic
   `DELETE … RETURNING` per table, every trigger row whose `jobName` is not in
   the live job registry, and reports what it removed. It runs after the
   register phase, so the registry is complete (an empty-registry guard prevents
   wiping valid triggers if ever called too early).
2. **Delivery self-heal** — `deliverToTrigger` (`deliver.ts`) resolves the
   target by name; an unknown job means the binding is dead, so it removes that
   trigger row and returns without throwing. This covers the window between a
   job's removal and the next boot sweep.

A trigger's `with` is the target's input; a field may instead name a field of
the event — `with: { pageId: eventField("pageId") }` (`internal/event-field.ts`,
stored as `{ "$eventField": "pageId" }` in `job_with`) — which delivery replaces
by the emitted payload's before parsing the input (a payload without it is
drift). That is how a per-subject job is one job for every caller (trigger,
backfill, button) and keys — and settles (`dedup: { key, settle }`, jobs) — on
its event's subject; with a constant `with` the subject reached it only through
`event`, which no key can see.

Static triggers are declared as `Trigger({ on, do, with })` contributions and
re-projected from code each boot by `syncTriggerContributions()`: their rows
carry `declared = true`, and the sync wipes every declared row (plus every row
of a declared job) and inserts the contributions' rows, so the declared rows
are a pure projection of code — renaming or removing a declared trigger's job
cannot leave a stale row. (Before the `declared` column the sync wiped only
the jobs still declared, so every such rename reached the sweep below as an
error, once per database.) The sweep is therefore only ever about a row a
runtime `trigger()` call made for a job that has since gone — a real leak. Trigger **tables** are real Drizzle tables
built inside `defineTriggerEvent`; deleting an event's source file makes
drizzle-kit generate a `DROP` migration on the next build, so orphaned trigger
tables can't linger either. Contract drift (target job exists but the stored `with` or the event
payload no longer parses against its schemas) is a genuine code-contract bug
and is deliberately **not** self-healed — the binding is still valid; the
contract just needs fixing, so deleting the trigger would be wrong. Delivery
reports it (`reportServerError`, scoped to the job) and skips that one target:
the failure is deterministic, so there is nothing to retry, and a drifted
subscriber must never fail — or roll back — the emitter.

## Delivery: inline, plus one outbox row per transactional emit

`emit()` resolves each matched trigger (`resolveDelivery`: unknown target →
self-heal, drift → report and skip) and enqueues its target with
`target.enqueue(with, { _event, tx })` — the target's own queue row, run id and
dedup key — right away when it can:

- **No `tx`**: every target is enqueued inline.
- **With `tx`**: a `dedup: "none"` target is enqueued on the caller's
  transaction (a plain insert; it commits or rolls back with the emitter's
  writes). A keyed or singleton target is NOT — its `job_key` upsert would hold
  that key's row lock until the caller commits, serializing emitters on shared
  keys and deadlocking two that take two keys in opposite orders. Those go into
  ONE `events.dispatch` row per emission, inserted on the transaction (the
  outbox), whose run enqueues each of them after commit (`enqueuesOnCallerTx`).

So an event costs its targets' runs plus at most one dispatch run. Until 2026-11
emit enqueued an `events.dispatch` row per matched trigger whose only work was
the target's enqueue — every event-triggered run cost two queue rows, two runs
and their bookkeeping (`tasks.statusChanged` matches ~7 triggers: ~14 runs per
status change, `events.dispatch` 29% of all lifetime runs on main). The job
still accepts that per-trigger shape, to drain rows queued before the change.

## Live reads

`eventTriggers` (`core/resources.ts`, key `event-triggers`) is a `liveValue` of
`TriggerRow[]` — every binding across every event, newest first, read whole by
Debug → Queue's Triggers tab (`useLive(eventTriggers)`). It is a value, not a
`liveCollection`, because its rows are a union over one `<event>_triggers` table
per event plus the computed `dangling` flag (target job not in the registry),
which a single-table collection cannot bind. Served by
`serveValue(eventTriggers, { source: "db" })` (its schema a `wholeList` with
the reason): the
loader's read-set is every trigger table, so any binding write pushes the whole
list. The `GET /api/events/triggers` endpoint serves the same rows wrapped as
`{ rows }` (`TriggersPayloadSchema`).

`eventEmissions` (`core/resources.ts`, key `event-emissions`) is a
`liveCollection` over the `event_emissions` ring: newest first, 200 rows by
default, grown up to `EMISSIONS_CAP` (1000, core) — the same constant every
emit() prunes the ring to, so a fully grown window is the whole ring. `eventEmissionsServed` serves it with
`serveCollection(eventEmissions, { from: _event_emissions })`; the row is the
entity (`EmissionRow`), bound by name. Debug → Queue's Events tab reads
`useLive(eventEmissions)` and grows the window at the scroll end. An emit's
insert and the ring's inline prune reach it through the change feed. The
`GET /api/events/emissions` endpoint serves rows wrapped as `{ rows }`
(`EmissionsPayloadSchema`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Event→job bindings layered on @plugins/jobs. Plugins declare events with typed filter columns via defineTriggerEvent, subscribers bind jobs via trigger(). Contributes a BackgroundTriggerSource so the Background activity catalog names the events that start each job.
- Load-bearing: yes
- Server:
  - Contributes:
    - `resource.declare` "event-emissions"
    - `resource.declare` "event-emissions:groups"
    - `resource.declare` "event-emissions:rows"
    - `resource.declare` "event-triggers"
    - `background.trigger-source` "job"
  - Uses:
    - `database.db`
    - `database.writeAtomically`
    - `database/sql-column.parsedJson`
    - `database/sql-projection.parsed`
    - `infra/background/catalog.BackgroundTriggerSource`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defaultRandom`
    - `infra/entities.defineEntity`
    - `infra/jobs.defineJob`
    - `infra/jobs.EnqueueTx`
    - `infra/jobs.getAllRegisteredJobNames`
    - `infra/jobs.RegisteredJob`
    - `infra/jobs.UNSAFE_getRegisteredJob`
    - `infra/jobs.UNSAFE_installDurableHooks`
    - `network/live.serveCollection`
    - `network/live.serveValue`
  - DB schema:
    - `plugins/infra/plugins/events/server/internal/event.ts`
    - `plugins/infra/plugins/events/server/internal/tables.ts`
  - Exports (types):
    - `DefineTriggerEventSpec`
    - `EmitTx`
    - `EventField`
    - `EventHandle`
    - `EventSource`
    - `FilterSlot`
    - `TriggerSpec`
    - `TriggerWith`
    - `UnsafeTriggerByNameSpec`
  - Exports (values):
    - `_event_emissions`
    - `defineTriggerEvent`
    - `deleteTrigger`
    - `deleteTriggersFor`
    - `eventField`
    - `trigger`
    - `Trigger`
    - `triggerTableRegistry`
    - `UNSAFE_triggerByName`
  - Register:
    - `defineJob('events.dispatch')`
    - `UNSAFE_installDurableHooks()`
  - Resources:
    - `event-emissions` (keyed, window)
    - `event-emissions:groups` (push)
    - `event-emissions:rows` (keyed, point)
    - `event-triggers` (push, whole: every binding across every event's own <event>_triggers table — the code's static Trigger() bindings plus one oneShot row per pending ctx.waitFor (a never-fired one lingers) — with the computed `dangling` flag: a union over N tables, which a single-table liveCollection cannot bind, whole: the payload one binding hands its job — a few named params, whole: one filter per typed column the event declares — a handful)
  - Routes:
    - `GET /api/events/emissions`
    - `GET /api/events/triggers`
    - `DELETE /api/events/triggers/:id`
    - `PATCH /api/events/triggers/:id`
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/json/config.jsonField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `fields/uuid/config.uuidField`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
  - Exports (types):
    - `EmissionListRow`
    - `EmissionMatch`
    - `EmissionRow`
    - `EmissionsPayload`
    - `PatchTriggerBody`
    - `TriggerRow`
    - `TriggersPayload`
  - Exports (values):
    - `deleteTriggerEndpoint`
    - `EmissionMatchSchema`
    - `EmissionRowSchema`
    - `EMISSIONS_CAP`
    - `EmissionsPayloadSchema`
    - `eventEmissionFields`
    - `eventEmissions`
    - `eventEmissionsEntityRef`
    - `eventTriggers`
    - `listEmissions`
    - `listTriggers`
    - `patchTriggerBodySchema`
    - `patchTriggerEndpoint`
    - `TriggerRowSchema`
    - `TriggersPayloadSchema`
- Cross-plugin:
  - Imported by: 38 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations` ×10
    - `tasks` ×10
    - `apps` ×7
    - `infra` ×4
    - `page` ×4
    - `build`
    - `debug/queue`
    - `wish`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `investigate:failures-registered` — `core/resources.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
