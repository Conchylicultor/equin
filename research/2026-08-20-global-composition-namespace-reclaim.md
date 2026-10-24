# Reclaiming a composition namespace

Phase 5 of [`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

Building a composition mints a namespace, and a namespace is three things on
disk plus one in Postgres: `~/.singularity/worktrees/<ns>/` (spec, dist,
`composition.json` marker, logs), `~/.singularity/state/config/<ns>/`, and a
database named `<ns>`. Nothing ever removes any of them.

Two ways they strand today:

- **The checkout goes away.** `debug/worktree-cleanup`'s `reapAttempt` reclaims
  a checkout's own namespace — its fork DB, config dir and spec dir — but its
  whole universe of names is `WORKTREE_NAME_RE = /^(att|claude)-\d+…/`. A
  namespace named `sonata.att-X` fails that regex, so every branch of the
  reaper is blind to it. Delete `att-X` and its `sonata.att-X` database,
  dist and spec survive it, unreachable and unnamed.
- **The composition goes away.** `useManifestActions().remove(id)` is one line —
  `setConfig("manifests", items.filter(i => i.id !== id))`. The served namespace,
  its database and its dist are untouched, and because every composition-aware
  surface (the list row, the serve panel) is keyed off the manifest item that no
  longer exists, they become invisible at the same moment they become permanent.

Deactivating is deliberately not a trigger — target-model point 5 says the
existing dist, spec and database stay live, and the serve panel's copy already
says so honestly. So the question this plan answers is what the trigger *is*.

**The answer: ownership, not intent.** A namespace is reclaimed when the thing
that owns it disappears, never because someone changed their mind about serving
it. A namespace has exactly one owner, recorded at mint time in its
`composition.json` marker (`{composition, checkout}`):

| marker | owner | reclaimed when |
|---|---|---|
| `{composition: "sonata", checkout: "att-X"}` | checkout `att-X` | `att-X` is deleted — automatically, with the checkout |
| `{composition: "sonata", checkout: null}` | the `sonata` manifest row | the row is deleted — on confirmation |
| no marker | the checkout of the same name | already handled by `reapAttempt` |

Toggling `autoBuild` off appears nowhere in that table, which is the point.

Scale this is worth: Postgres is currently **77 GB across 182 databases** (~450 MB
each, and a fork is a real file copy, not copy-on-write). 16 of those databases
belong to checkouts that no longer exist. That backlog is pure loss today and is
cleared by this plan's sweep on its first run.

---

## Design

### 1. `reclaimNamespace(ns)` — the missing primitive

`reapAttempt` today is two different jobs fused into one function: it removes a
*checkout* (the git worktree) and it reclaims a *namespace* (DB → config dir →
spec dir). Split the second half out, unchanged.

**It goes in a new sub-plugin, `infra/worktree/plugins/reclaim/`, not in
`infra/worktree` itself.** Five CLI command files import
`@plugins/infra/plugins/worktree/server` (`build`, `check`, `push`,
`build-targets`, `deploy-namespace`), so anything added to that barrel joins the
CLI *process*'s static import closure. `reclaimNamespace` imports
`database/admin/server` and `database/zero/…/cache-service/server`, which reach
`infra/jobs` and the DB pool — a large closure to graft onto a barrel the CLI
freezes at load, and exactly the surface `cli:codegen-manifests-not-frozen`
guards. Keeping it in its own sub-plugin means the parent barrel gains nothing.

```ts
// plugins/infra/plugins/worktree/plugins/reclaim/server/internal/reclaim-namespace.ts
export async function reclaimNamespace(
  ns: Namespace,
  onStep?: (step: "database" | "config" | "registry") => void,
): Promise<void>
```

Direction is clean: neither `database/admin` nor `database/zero/cache-service`
imports `infra/worktree`, so these are new edges, not a cycle.

The body is lifted verbatim from `reap.ts` steps 2–4, including both comments
that encode real incidents: drop Zero replication artifacts **before** the DB
(`DROP DATABASE WITH (FORCE)` terminates backends but not replication slots, and
a leftover slot makes the drop fail), and guard the DB steps on
`databaseExists` (otherwise `dropZeroReplicationArtifacts` throws and aborts the
reap before the registry step, anchoring the gateway registration forever).

`removeWorktreeSpec(ns)` already `rm -rf`s the whole namespace dir, so the dist
and the marker are reclaimed by the step that deregisters — deleting the spec is
the gateway's only deregistration path, and `registry.remove()` stops the backend
and cleans its sockets. Nothing new is needed for "dist".

`reapAttempt(id)` then becomes `removeWorktree(path)` + `reclaimNamespace(id)` +
the derived set below. Its four-step `onStep` union gains one arm; the streaming
delete handler and its UI follow.

### 2. `namespacesOwnedBy` — asked for, not enumerated

The marker is the inverse of `namespaceFor` — deliberately, per
`composition-namespace.ts`: "Decomposing `foo` back into a (composition,
checkout) pair would need the composition set at every reader; recording the pair
where it is MINTED cannot be ambiguous." Two readers on top of one scan. They
are pure filesystem reads, but they live in the same `reclaim` sub-plugin rather
than the parent: they exist to answer "what would a reclaim take", both consumers
already import that barrel, and putting them beside `readCompositionMarker`
would buy nothing while spreading the feature over two plugins.

```ts
interface OwnedNamespace { ns: Namespace; marker: CompositionMarker }
listCompositionNamespaces(): Promise<OwnedNamespace[]>          // readdir + marker read
namespacesOwnedByCheckout(checkout: string): Promise<OwnedNamespace[]>
namespacesOwnedByComposition(id: string): Promise<OwnedNamespace[]>
```

This is the structural half of the change. `reapAttempt` does not name
composition namespaces; it asks "what does this checkout own?" and reclaims the
answer. A namespace kind invented later is reclaimed with no edit to the reaper —
which is the difference between this and adding a fifth hardcoded step.

**Marker arms, all three rendered rather than collapsed:**

- `checkout: "<name>"` → owned by that checkout.
- `checkout: null` → owned by main; never a target of the checkout trigger.
- `checkout: undefined` → written before the field existed. **Never a target**,
  reported as owner-unknown. The marker's own docblock sets this precedent
  ("a reader reports that as unknown rather than guessing"), and guessing here
  would drop a database.

### 3. Trigger A — the checkout disappears (automatic)

Two paths, because a checkout can leave two ways.

**Through the reaper.** `reapAttempt(id)` reclaims `namespacesOwnedByCheckout(id)`
before its own namespace step. Covers the Debug → Worktree Cleanup delete button,
the bulk delete, and the hourly `worktree-cleanup.reap-stale` job. Per-namespace
failures are contained and reported the way per-target failures already are, so
one undroppable database cannot block the rest of a sweep.

**Through the sweep**, for checkouts that left without a reap — deleted
externally, or reaped before this landed (the 16-database backlog). A new branch
in `collectReapable`, kept in its own universe:

> **Do not widen `WORKTREE_NAME_RE` to admit dotted names.** Every existing
> branch treats a name matching that regex as a checkout id, so admitting
> `sonata` (main-owned, must never be swept) or `sonata.att-X` there would route
> them through checkout logic that resolves a git worktree path from the name.
> The marker set is a *separate* enumeration answering a *separate* question.

The branch honours the file's existing invariant verbatim — **the readdir set may
only skip work, never authorize it** — so a marker naming a missing checkout is
confirmed with a real `dirExists(worktreePathFor(marker.checkout))` before it
authorizes a target. A checkout whose attempt is still `retained` is never a
target, same as every other branch.

No age floor, matching the existing age-free orphan branch: the checkout is gone,
the namespace cannot be rebuilt or meaningfully reached, and there is nothing for
a grace period to protect.

### 4. Trigger B — the composition is deleted (confirmed)

`remove(id)` stops being a silent config edit. Before filtering the row it asks
`namespacesOwnedByComposition(id)` (a new endpoint on
`build/serve-composition`'s server, which already owns the marker-reading
`handle-status`) and, when the answer is non-empty, opens a `confirmDialog`
naming exactly what will be destroyed — each namespace, its host, and whether it
carries a database — then reclaims them before removing the row.

Both delete call sites go through it, so the two cannot drift:
`web/components/composition-item-actions.tsx` (list row) and
`plugins/draft-actions/web/components/draft-actions.tsx` (detail pane).

Guards on the server side mirror `resetCompositionData`'s, which is the existing
precedent for wiping a composition's data safely — reuse them rather than
restating: `assertServableCompositionNamespace` (never `central`, `singularity`,
`main`), `hasCompositionMarker(ns)` (a marker-less dir belongs to a checkout;
refuse), and `namespaceCollision`. A reclaim that cannot prove ownership fails
loudly and touches nothing.

This is the one trigger that can destroy data the user cares about — `sonata`'s
database on main holds real content — so it is explicit, confirmed, and never
reached by editing a flag.

### 5. The filtered registry, the fourth artifact

`cli/CLAUDE.md` names this file and assigns it here: "**Filtered registries are
never swept.** They used to be, by the compose-serve deactivation stage; with
that stage deleted they accumulate in every checkout that has ever served
something. Gitignored, but they are `tsc` input. Phase 5 … owns the reclaim
trigger."

Reclaiming `<comp>.<checkout>` also removes that checkout's
`plugins/framework/plugins/server-core/core/server.composition.<comp>.generated.ts`.
Note the asymmetry: this is the one artifact living inside a *checkout* rather
than the shared data dir, so it is resolved from `marker.checkout` and is free
when the checkout itself is being deleted. Order it **after** the spec removal —
the spec is what stops the backend, and the backend reads this file at spawn.

---

## Files

| File | Change |
|---|---|
| `plugins/infra/plugins/worktree/plugins/reclaim/` | **new sub-plugin** — `reclaimNamespace` (lifted from `reap.ts`) plus `listCompositionNamespaces` / `namespacesOwnedByCheckout` / `namespacesOwnedByComposition`, behind its own `server/index.ts` barrel |
| `plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts` | `reapAttempt` delegates; reclaims the derived set first; `onStep` gains `"namespaces"` |
| `…/worktree-cleanup/server/internal/reap-policy.ts` | marker-owned orphan branch (separate from `WORKTREE_NAME_RE`) |
| `…/worktree-cleanup/server/internal/reap-policy.test.ts` | cases for the new branch — see below |
| `…/worktree-cleanup/server/internal/handle-delete.ts`, `web/components/worktree-cleanup-panel.tsx` | surface the new step |
| `plugins/build/plugins/serve-composition/shared/endpoints.ts`, `server/internal/` | `namespacesOwnedByComposition` endpoint + reclaim endpoint, guards shared with `reset.ts` |
| `plugins/plugin-meta/plugins/composition/web/internal/manifests.ts` | `remove(id)` gains the reclaim path |
| `plugins/apps/plugins/studio/plugins/compositions/web/components/composition-item-actions.tsx`, `plugins/draft-actions/web/components/draft-actions.tsx` | route both deletes through it |
| `plugins/framework/plugins/cli/CLAUDE.md`, `research/2026-08-17-…md` | drop the "never swept" / "Phase 5 owns" notes; mark Phase 5 landed |

Reused as-is, not reimplemented: `configDir.file(ns)`, `dropDatabase` /
`databaseExists` / `dropZeroReplicationArtifacts`, `removeWorktreeSpec`,
`readCompositionMarker` / `hasCompositionMarker`, `assertServableCompositionNamespace`,
`worktreePathFor`, `dirExists`, `confirmDialog`, `ndjsonResponse`.

No CLI verb. `./equin clean` belongs to the `ReclaimPolicy` work in
`research/2026-08-17-global-singularity-data-dir-layout.md`, which already owns
that vocabulary.

---

## Verification

**Unit** — extend `reap-policy.test.ts` (pure classifier, no DB) with: a marker
whose checkout dir is gone is a target; `checkout: null` is never a target;
`checkout: undefined` is never a target; a marker whose checkout dir is present
is not a target; a marker-less dir is not reached by the new branch. Run with
`./equin test plugins/debug/plugins/worktree-cleanup`.

**End to end**, from this worktree:

1. `./equin build --composition sonata` → confirm `sonata.att-X` is live at
   `http://sonata.att-1787216249-3iy2.localhost:9000`, that
   `~/.singularity/worktrees/sonata.att-X/{spec.json,composition.json,web}` exist,
   and that the database exists (`query_db` on `singularity`:
   `select datname from pg_database where datname like 'sonata.%'`).
2. Delete that checkout from Debug → Worktree Cleanup. Confirm the stream shows
   the namespaces step, then that the dir, the config dir and the database are
   all gone, and the host 404s.
3. In Studio → Compositions, delete a composition served from main. Confirm the
   dialog names its namespace and database, and that confirming removes both plus
   the row; confirm cancelling leaves everything, including the row.
4. Toggle a served composition's `autoBuild` off. Confirm **nothing** is
   reclaimed — the deactivation-is-not-a-trigger property, asserted rather than
   assumed.
5. Let the hourly job run once (or invoke it) and re-measure
   `select count(*), pg_size_pretty(sum(pg_database_size(datname))) from pg_database`
   against the 182 / 77 GB baseline — the 16 checkout-less databases should be
   gone.

**Checks** — `./equin check` green, in particular `plugin-boundaries` (the
new edges `reclaim → database/admin` and `reclaim → database/zero/…/cache-service`
are acyclic, verified above), `cli:codegen-manifests-not-frozen` (the reason the
primitive is a sub-plugin — this check is what would catch the mistake if it were
put in the parent barrel), `plugins-registry-in-sync` and `plugins-doc-in-sync`
for the new sub-plugin.

## Known gaps left open

- **Main-owned namespaces have no automatic reclaim, by design** — your rule that
  `singularity`, `sonata` and any contribution on main are preserved. They are
  reclaimed only through trigger B.
- **The four legacy flat `worktrees/<name>.json` specs** (May, pre-subdir layout)
  and non-checkout dirs like `central` / `head-check` predate every trigger here
  and are not swept. Separate cleanup, not this phase.
- **`reapAttempt`'s artifact list is still a hardcoded sequence** for the checkout's
  own artifacts. This plan makes the *derived namespace* set a question rather
  than a list; making the whole set a contribution registry is a larger change,
  worth its own task if a third kind of checkout-derived artifact appears.
