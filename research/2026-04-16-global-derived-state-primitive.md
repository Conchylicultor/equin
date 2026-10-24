# Derived state primitive: declare dependencies, never propagate

## Context

A recurring shape of problem is already visible in the codebase and will
multiply as plugins accumulate:

- `task.status` depends on whether an attempt exists and what its
  conversation is doing (todo → in-progress → completed). Today this
  would be computed in a resolver ad-hoc, or worse, stored on the row
  and updated by every code path that touches an attempt.
- `conversation.phase` is derived from runtime state + latest message
  (see `2026-04-15-conversations-phase-indicator.md`).
- `edited-files` count is derived from worktree fs state.
- Future: `task.progress` from its subtree, `stats/*` from commits,
  permissions from roles, any UI badge that summarises nested state.

Every one of these is the same shape: **a value that must always
reflect other values**. The naïve answer — store it and update it from
every writer — does not scale. It drifts, silently, and the only
signal is "why is this row stale?" in production.

Three layers of response exist in the industry:

1. **Server-side derivation.** Compute at read time (SQL view,
   resolver), or use triggers / generated columns / incremental view
   maintenance (`pg_ivm`, Materialize) to keep derivations
   auto-correct.
2. **Reactive sync to the client.** Subscription engines (Convex,
   Zero, Replicache, LiveStore) make queries stay live on the client.
3. **Event sourcing / CQRS.** Derive everything from an append-only
   log.

We already have layer-2 infrastructure in a Gen-1 form: `defineResource`
with `push` / `invalidate` modes and a coalesced `notify()` path over
`/ws/notifications`. What we lack is a layer-1 primitive: a declared,
enforceable way to say *"this resource's value is derived from these
other resources, so when they change, invalidate here too."*

This doc proposes that primitive, and the conventions around it, as a
reusable foundation — not a fix for `task.status` specifically. The
goal is that every future "X depends on Y" relationship becomes a
one-line declaration, and manual propagation becomes a ban.

## Principle

Two rules, enforced by the framework:

1. **Derivation is declared.** A derived value names its upstream
   sources at definition time. The framework owns invalidation.
2. **Never stored, never manually written.** If a value can be
   computed from others, it does not live as a column that writers
   update. It lives behind the primitive, which computes on read and
   caches at the resource layer.

The rules are worthless without enforcement. Both are checked by
`./equin check` (see §Enforcement).

## Design

### The primitive: `dependsOn` on `defineResource`

The smallest change that yields the principle: extend the existing
`ResourceDefinition` with a `dependsOn` field. When any listed upstream
resource calls `.notify(params)`, the framework automatically calls
`.notify()` on the dependent, with its own `params` rederived from the
upstream params.

```ts
// plugins/tasks/server/internal/resources.ts
import { defineResource } from "@singularity/server/resources";
import { attemptsResource } from "../../../attempts/server/api";
import { conversationsResource } from "../../../conversations/server/api";

export const tasksResource = defineResource({
  key: "tasks",
  mode: "push",
  dependsOn: [
    { resource: attemptsResource },
    { resource: conversationsResource },
  ],
  loader: async () => {
    const [rows, attempts, convos] = await Promise.all([
      db.select().from(tasks),
      attemptsResource.load({}),
      conversationsResource.load({}),
    ]);
    return rows.map((t) => ({
      ...t,
      status: computeStatus(t, attempts, convos),
    }));
  },
});
```

The `status` field never exists in the Drizzle schema. It is computed
inside the loader and shipped on the wire. When `attemptsResource`
notifies, the framework schedules a `tasksResource.notify()` on the
same microtask flush. Subscribers of `tasks` see a consistent level
state — no stale window, no drift, no manual hook.

### Parameter mapping

For parameter-keyed resources (`edited-files` keyed by conversation
id), `dependsOn` needs a `map` so an upstream notify translates into
the right downstream params:

```ts
dependsOn: [
  {
    resource: conversationsResource,
    map: (upstreamParams /* {} */, upstreamValue) =>
      upstreamValue.map((c) => ({ id: c.id })),
  },
],
```

Default when `map` is omitted: identity. The conventional case
(resource-wide invalidation) needs zero mapping code.

### Derivation inside the loader

The loader is authoritative. It reads whatever it needs — the DB, the
upstream resources' cached latest, the filesystem — and returns the
shape it wants subscribers to see. Two escape hatches matter:

- `upstream.load({...})` inside a loader is allowed and common. The
  framework will not cycle-detect at call time; it cycle-detects the
  `dependsOn` DAG at registration.
- Raw SQL joins are allowed. `dependsOn` is orthogonal to *how* the
  loader computes. You can ignore the upstream's cached value and do
  the join at the DB; `dependsOn` is purely about invalidation.

### Cycle detection

`dependsOn` forms a DAG over resource keys. At boot, after all
`defineResource` calls, the framework walks the DAG and throws on any
cycle. Error lists the offending keys so the plugin author sees it
immediately on startup.

### Fan-out coalescing

One upstream notify can cascade through many derived resources. The
flush already coalesces per-resource per-params-tuple; the cascade
just extends that: `upstream.notify() → schedule downstream.notify()`
within the same microtask flush. Net effect is one loader call per
derived key per tick regardless of how many upstreams fired.

### HTTP fallback

`GET /api/resources/:key` continues to work unchanged — it calls the
loader. Derived resources are indistinguishable from regular ones on
the wire. Clients keep using `useResource(tasksResource)`.

### Schema convention

Derived fields are **never added to Drizzle's `schema.ts`**. They
exist only on the loader's return type. This is the teeth behind "never
stored, never manually written":

- If it's a column in `schema.ts`, writers *can* update it. Derivation
  leaks.
- If it's only on the loader's TS return, the only way to set it is
  to compute it. Derivation holds.

Corollary: a plugin's `schema.ts` is the stored-state schema. The
resource's loader return type is the **exposed** schema. They are
allowed to differ, and for derived fields they must.

### File layout

Per plugin, when derivations appear:

```
plugins/{name}/server/
  schema.ts                 # Drizzle: stored columns only
  internal/
    resources.ts            # defineResource with dependsOn
    derived.ts              # pure compute functions (computeStatus, …)
```

Pure compute functions live in `derived.ts` and are unit-testable in
isolation. `resources.ts` wires them to the loader. This mirrors the
`handle-*.ts` split already in use.

## Enforcement

Three `./equin check` additions, each cheap:

1. **`derived-not-stored`** — AST scan: for each resource, diff the
   loader's inferred return type against the plugin's Drizzle schema
   columns. Any field that appears in the return type but not in the
   schema must be either (a) imported from another plugin's schema, or
   (b) produced by a `computeX` helper referenced in `dependsOn`.
   Forbids adding a derived field silently to `schema.ts`.
2. **`no-manual-notify-on-derived`** — grep for
   `<derivedResource>.notify(` outside the resource's own file.
   Derived resources are invalidated by the framework only; any
   hand-written `notify()` means someone is papering over a missing
   `dependsOn`.
3. **`dependsOn-acyclic`** — runs at build, reusing the boot-time DAG
   walk. Boot would already fail; the check surfaces it in CI before
   deploy.

These turn the principle into something agents (and humans) cannot
violate by accident.

## Phased rollout

### Phase 1 — the primitive (~1 day)

- `server/src/resources.ts`: add `dependsOn?: Array<{ resource:
  Resource<any, any>; map?: (p, v) => P[] | P | undefined }>` to
  `ResourceDefinition`. On `defineResource`, register the edge in a
  module-level DAG.
- Extend `flushNotifies` so that after a resource's pending notifies
  are processed, downstream resources from the DAG are scheduled. One
  extra loop inside the existing flush.
- Boot-time cycle check.
- No migration of existing resources yet.

### Phase 2 — first adopters

- `task.status` as the canonical example, following the file layout
  above. `derived.ts` with `computeStatus`; resource with `dependsOn:
  [attemptsResource]`.
- `conversation.phase` migrated off its ad-hoc tracking (see
  `2026-04-15-conversations-phase-indicator.md`).
- Document the pattern in `plugin-core/CLAUDE.md` and
  `server/CLAUDE.md`.

### Phase 3 — enforcement

- Land the three checks. Use the first real violation (inevitable) to
  tighten the rules before they proliferate.

### Phase 4 — optional, on signal

Only if read-time cost or query shape becomes a problem:

- **Materialise a derived resource into a Postgres view.** Same
  `defineResource` declaration; implementation reads from the view
  instead of joining in TS. Plugin code does not change.
- **`pg_ivm` for incremental maintenance.** Same API, zero-cost reads
  once ingested.
- **Promote to schema column via generated column** for single-row
  derivations Postgres can handle natively.

These are implementation swaps behind the primitive. We do not commit
to them up front.

## Tradeoffs

- **Read cost.** Loader runs on every invalidate. For now this is
  fine — `tasks` is tens of rows, join is cheap. Phase-4 escape hatches
  exist when it isn't.
- **Debuggability of cascades.** A single upstream notify can fan out
  to many derived resources. The `/api/resources/_debug` endpoint
  needs to surface the DAG and the last cascade so this is visible.
- **Cache coherence of upstream.load() inside loaders.** If loader A
  calls `upstreamB.load({})` while B is mid-recompute, A sees B's
  pre-update value. Acceptable: the framework schedules A's rerun
  right after B finishes, so A converges within one more flush. Worth
  documenting; not worth a coordination protocol for now.
- **"Derived" creep.** Someone will want a derived value computed on
  the *client*, or derived across workspaces. Out of scope for this
  primitive; revisit when it appears.

## Non-goals

- **Full IVM / streaming SQL.** Not now. The primitive's design leaves
  room for it as a later implementation; adopting it now is a
  cathedral for a picture.
- **Client-side reactive queries (Convex/Zero-style).** The existing
  `useResource` + WS push covers our current needs. When we hit
  multiplayer pain, this doc's primitive still fits underneath that
  stack.
- **Replacing event-bus-style cross-plugin coordination.** Derivation
  is for "Y is a function of X." Side effects ("when a task is
  created, kick off a worktree") stay in their current handler-driven
  shape.

## Open questions

- **`dependsOn` on DB tables directly?** For resources that are a thin
  wrapper over a single table, declaring `dependsOn: [tasks]`
  (Drizzle table) instead of `[tasksResource]` would reduce
  boilerplate. Requires a way to observe DB writes — either by routing
  all writes through a primitive that auto-notifies, or by
  `LISTEN/NOTIFY`. Defer until phase 2 feedback.
- **Per-params `dependsOn`.** Today every notify on the upstream
  cascades to every params of the downstream. For sparse upstreams
  (`edited-files[id=A]` doesn't need to invalidate
  `task[id=B]`), the `map` callback narrows this. Works; the
  question is whether we need a tighter default.
- **Client-side derivation.** If a plugin wants `useDerived(resource,
  fn)` on the client, should it mirror the server API? Likely yes for
  consistency. Out of scope for phase 1.
- **Testing.** Derivation logic belongs in pure functions in
  `derived.ts` — unit-testable. The resource wiring (`dependsOn`
  correctness) should have an integration test per plugin that writes
  upstream state and asserts the downstream notify fires. A shared
  test helper in `plugin-core` would be worth it once two plugins
  need it.

## Critical files (phase 1)

- `server/src/resources.ts` — add `dependsOn`, DAG registration,
  cascade inside `flushNotifies`, boot cycle check.
- `server/CLAUDE.md` — document the new field next to `defineResource`.
- `plugin-core/CLAUDE.md` — add the schema convention and the
  `derived.ts` layout.
- `cli/src/checks/` — three new checks (phase 3, not phase 1).

## Why this is the right foundation

The primitive is tiny — a few hundred lines in `resources.ts`, a
schema convention, three checks. What it buys:

- Every future derivation is a one-line `dependsOn` and a pure
  compute function.
- Manual propagation becomes a check failure, not a code review
  question.
- The implementation behind it is swappable: resolver-level today, SQL
  view tomorrow, IVM later, reactive sync engine someday. The plugin
  code does not change.
- Agents learn one primitive. "Add a derived field" becomes a rote
  pattern, not a design conversation.

The durable investment is not the code. It is the principle, enforced
by the framework, that every value in the system is either stored or
declared-derived — never both, never manually propagated.
