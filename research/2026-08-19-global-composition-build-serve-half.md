# Phase 4 — one build verb: the serve half

Phase 4 of
[`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).
Phases 1 (`singularity` is a manifest entry) and 3 (`namespaceFor` + the
multi-label gateway) have landed.

## Context

There is no way to build and serve one composition on its own.
`build --serve-composition sonata` runs a **complete main build** and projects
sonata into its namespace at the tail, and it refuses to run anywhere but the
main checkout. So an agent working on a composition in its own worktree cannot
see it running.

Three causes, all in one code path:

- **The main-first coupling.** The compose-serve stage hands the pipeline MAIN's
  full-fleet vendor set via `readFleetVendorMeta`, which throws unless the whole
  non-composition fleet is already in this host's artifact store. (The shortcut
  existed for a reason: a *served* dist symlinks the vendor-set dir, so a
  superset costs nothing on disk, whereas a hermetic dist copies it whole.)
- **Serving is main-gated in four places** — the serve endpoint 400s off main
  (`handle-serve-composition.ts`), the CLI preflight exits (`build.ts:823`), the
  stage early-returns (`build.ts:1739`), and the config read is hardcoded to
  `singularity`'s resolved layer (`compose-serve.ts:142`). A composition backend
  is also spawned from **main's** `server-core`, not the checkout that built it.
- **Once `--composition` does this directly**, `--serve-composition` and the
  compose-serve stage have no caller left.

Outcome: `./equin build --composition sonata` builds and serves sonata
from any checkout, at `http://sonata.<checkout>.localhost:9000`. Databases become
one per (composition × checkout).

---

## The decision that reshapes the phase: selection by identity, not by presence

`selectRegistry(coreDir, namespace)` picks
`server.composition.<namespace>.generated.ts` **if that file exists**, else the
committed `server.generated.ts`. File presence is being used as identity, and it
misfires in both directions:

- Building composition `singularity` naturally emits
  `server.composition.singularity.generated.ts`, and main's namespace **is**
  `singularity` — so the file silently reconfigures main's backend on its next
  spawn. That is why Phase 2 refused `--hermetic --composition singularity`, and
  why **releasing the main app is currently impossible**.
- A served composition whose checkout was `git clean`ed loses its filtered
  registry and silently boots the **full** app under the composition's namespace
  and database.

Both are the same bug. The fix makes the composition explicit:

1. `WorktreeSpec` gains `composition?: string`, and the backend reads it back
   off its own `spec.json` at boot (one field, one read). NOT an env var the
   gateway passes: `./equin build` does not rebuild the Go gateway, so a
   running gateway is routinely older than the tree it serves and would simply
   not pass it — and a backend that saw no composition would boot the full app
   under the composition's own namespace and database, which is the exact bug
   this change removes. Reading the same file the gateway read leaves no hop
   that can drop the value.
2. `selectRegistry(coreDir, composition)` resolves the registry for that
   composition and **throws** when the file it names is absent.
3. One function — `compositionRegistryPath(def, composition)` — answers "where
   does composition C's registry live": the committed `<dir>.generated.ts` for
   `singularity`, the gitignored `<dir>.composition.<C>.generated.ts` otherwise.

**`singularity` is then an ordinary composition.** There is no carve-out for it;
the single fact recorded in one place is that *its registry is the committed
one*, which is exactly what Phase 1's `plugins-registry-in-sync` proves. Three
things fall out: `build` and `build --composition singularity` are identical by
construction, a stray registry file is inert, and the
`--hermetic --composition singularity` refusal is deleted — reopening the
main-app release the model doc names as a capability gap Phase 3/4 must close.

It also removes churn my first sketch would have caused: registry filenames stay
keyed by a **single-label composition id**, so no dotted filenames, no widened
filename grammar, and `release.ts` needs no change.

**Land this first, on its own.** It is independently valuable, and landing the
fan-out on top of presence-keyed registries means every composition build from
main writes a file that can reconfigure a live backend.

---

## Settled decisions

| Question | Decision |
|---|---|
| Auto-serve on a main build | **Deleted outright.** A main build builds main. The deactivation sweep goes with it (target-model point 5). The Serve button still works — it POSTs a build of that one composition — so the capability survives; only "every main build refreshes them" goes, and Phase 6 owns the replacement trigger. |
| `build --composition sonata website` run rows | **One row, N target chips.** One invocation is one shared build — one install, one codegen, one migration pass, one checks pass, one transcript, one profile, one verdict — so it is one row, rendered `[manual] [sonata] [website]`. `target text` becomes `targets text[]`. **No parent.** Recorded in the **building checkout's** DB with `namespace` = that checkout's namespace. Sequential invocations are what produce separate rows. |
| Dotted namespace as a Postgres database name | **Widen `assertSafeName` to the namespace grammar**, so the DB-name rule and the namespace rule are one rule. |
| `--composition singularity` | Ordinary composition — see above. |

---

## The shape

`runHermeticBuild` already has the right shape and the deploy posture should
mirror it: **shared prefix once, then a loop over targets.**

```
per invocation:  preflight → resolve targets → lock → stage 1 (deps + every
                 target's registry) → stage 2 (migrations + codegen) → format →
                 validation → ONE verdict
per target:      sweep dist → build+publish dist → DB → propagate config →
                 marker → spec (with composition) → restart → health probe →
                 receipt → build_runs row
```

Do **not** loop the tail inside `build.ts`. Its terminal funnel (`failBuild`)
closes over eleven invocation-scoped values; fanning out inside the largest
closure in the repo is how this file got to 1913 lines. Two new modules:

**`cli/bin/commands/internal/build-targets.ts`** — `resolveBuildTargets({ root,
requested, checkout })` → `BuildTarget[]` of
`{ composition, namespace, item, isMainComposition }`. The one place that decides
what a target *is*: reads the **resolved** manifest off disk, `assertCompositionId`,
`namespaceFor`, `namespaceCollision` + `probeNamespace`, and the default
`[singularity @ checkoutRef(root)]`. Read the config off disk — never `import()`
a codegen manifest, or `cli:codegen-manifests-not-frozen` fires.

**`cli/bin/commands/internal/deploy-namespace.ts`** — `deployNamespace(opts)`
returning a **discriminated result**, never calling `process.exit`, exactly like
`ArtifactBuildResult`. Absorbs `serveOne`'s marker write (now populating the
marker's existing `checkout` field), its collision guard, and its tolerant
`restartNamespace`. `build.ts` keeps the funnel, the guard, the receipts, the
recorder and the verdict.

`compose-serve.ts` is deleted.

### Per-invocation vs per-target

The file assumes one namespace per process in six module-global places. **ckNs**
= the checkout's own namespace (`namespaceFor(singularity, checkoutRef(root))`).

Stay **per-invocation**, keyed on ckNs: `openBuildProgress` (module-global
`current`; a second call is a silent no-op), `createOpProfiler({ opSlug })`,
`markWorktreeOpStart`/`setWorktreeOpPhase`/`clearWorktreeOp` (one marker per
`(worktree, op)` — N markers means N−1 strays and the agent's pane never reads
"working"), `installVerdictGuard` (module-global `emittedVerdict` — exactly one
verdict per process; it takes `urls: string[]` now), `installFatalSignalExit`,
`acquireArtifactLock`, `readHead`/`supersededBy`, `reapLegacyCheckoutDist`,
`writeBuildProfile`/`writeBuildLogs`, `flushFootprint`, the central-routes and
central-restart block, the **single `build_runs` row**
(`recorder.insertRun`/`closeRun`), and `generateAppSources({ worktreeName })` —
that name only sets `SINGULARITY_WORKTREE` for drizzle-kit, so it must be ckNs
or drizzle generates against an empty DB.

The ledger row belongs with the log and the profile, and that is the whole
argument for one row: those three are already one-per-process (module-global
collectors, one verdict), so N rows would each point at the same transcript.

Become **per-target**: the deploy receipt (`receipt` becomes a
`Map<Namespace, BuildReceipt>`; `recordSignal` stamps every open entry,
`finalizeBuild` closes every one — the receipt is per-*namespace* by definition,
it is the file the gateway-facing deploy answers for),
`reportInterruptedPredecessor`,
`propagateConfigToUser({ userConfigDir: configDir.file(tgtNs) })`,
`buildAndPublishWebDist`, `writeWorktreeSpec`, and the gateway restart +
`readHealthStartedAt` + `probeHealth`.

**Fail-fast across targets**, matching `hermetic-build.ts:364`: the first failure
ends the invocation, and the verdict names what published, what failed, and what
was not attempted. One row, one exit code — honest, because the invocation is
the unit of work.

Three that need naming:

- **`sweepDistLeftovers` runs for ALL targets up front**, before any staging dir
  exists — the same reason `hermetic-build.ts:231` does it that way. Sweeping
  inside the loop deletes target 2's staging dir while target 1's is live.
- **Database: opposite operations, not one function with a flag.** Main
  composition ⇒ `waitForWorktreeDatabase(ckNs)` (the fork carries main's data,
  never create it). Any other ⇒ `ensureDatabase(tgtNs)` (empty; the backend's
  boot migrator fills it).
- **`getAdminPool().end()`** moves out of the stage's `finally` and into
  `finalizeBuild`. In a loop, target 1's close ends the pool target 2's
  `ensureDatabase` needs.

`companions` (the checks pass) are built once and passed to the **first target
only**, `i === 0`, as hermetic already does — validation belongs to the source
tree, which every target shares.

### Artifact locality — a hard constraint

`build-logs/server/internal/handle-build-run-logs.ts:20` reads
`worktreeArtifacts.buildLogs(currentWorktreeName(), buildId)`. So a run's
profile/log artifacts must live under the namespace of the backend **whose DB
holds the row** — i.e. under ckNs, keyed by the one `buildId`. Not under a
target's own data dir, and no `-c-<composition>` suffix: one invocation, one
row, one pair of artifacts.

---

## Files

**Registry selection (land first, alone)**
- `plugins/infra/plugins/worktree/server/internal/spec.ts` — `composition?: string`
  on `WorktreeSpec`, written additively so an absent value serializes
  byte-identically.
- `gateway/worktree.go` — `Composition` on `Spec` only. The gateway carries the
  field through its own spec round-trip (dropping an unknown field would erase
  it) and does not interpret or forward it; the backend does the reading.
- `plugins/framework/plugins/server-core/bin/select-registry.ts` — take the
  composition, resolve through `compositionRegistryPath`, throw when the named
  file is absent. Keep the inline `NAMESPACE_RE` literal byte-exact
  (`namespace:grammar-in-sync` matches on the source text).
- `plugins/framework/plugins/server-core/bin/spec-composition.ts` — new, pure +
  tested: `readSpecComposition(worktreesDir, namespace)` reads
  `<worktreesDir>/<namespace>/spec.json` and answers with its `composition`.
  Absent namespace / absent file / absent key all mean the main app; a spec that
  exists but is corrupt THROWS.
- `plugins/framework/plugins/server-core/bin/plugins-active.ts` — pass
  `readSpecComposition(worktreesDir(), process.env.SINGULARITY_WORKTREE)`.
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`
  — `compositionRegistryPath(def, composition)`; `generateCompositionRegistry`
  skips the main composition (its registry is the committed one).
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/plan.ts`
  — `compositionFleetSource` returns `defaultFleetSource` for the main
  composition; `registrySlug` stays `web-registry-<composition>`, so the artifact
  still dedups across checkouts.
- `plugins/framework/plugins/cli/bin/commands/internal/hermetic-build.ts` —
  delete the `--composition singularity` conflict.

**Namespace + database**
- `plugins/infra/plugins/namespace/core/namespace.ts` — cap a composed namespace
  at **63 bytes** in `NAMESPACE_RE` and `namespaceFor`. Postgres `NAMEDATALEN` is
  64, so `datname` silently truncates at 63 and two long namespaces would collapse
  onto one database. Enforce it at the minter (rung 2/4), not by a check.
- `gateway/registry.go` + `select-registry.ts` — mirror the cap;
  `plugins/infra/plugins/namespace/check/index.ts` pins the three copies.
- `plugins/database/plugins/admin/server/internal/databases.ts` — widen
  `assertSafeName` from `/^[a-zA-Z0-9_-]+$/` to the two-label namespace grammar
  plus the length assertion. It is a SQL-identifier boundary (`DROP DATABASE
  "${name}"`), so an explicit allowlist, never `.*`. The second copy in `fork.ts`
  is **not** on this path (fork temp names are sha8-hashed) — leave it and say so.

**CLI**
- `bin/commands/internal/build-targets.ts` — new (above).
- `bin/commands/internal/deploy-namespace.ts` — new (above).
- `bin/commands/internal/compose-serve.ts` + its test — **deleted**, along with
  `sweepIds`, `markerNamespaces` and the deactivation sweep.
- `bin/commands/build.ts` — drop the `--composition` refusal, `--serve-composition`
  (flag, preflight, `runComposeServe`); `receipt` → `Map`; `urls` on the verdict
  guard; `NAME_REGEX` → `NAMESPACE_RE`; loop over `deployNamespace`; funnel
  wording gains published / not-attempted, mirroring `hermetic-build.ts:364`.
- `bin/commands/internal/app-artifacts.ts` — `prepareCompositionSources` takes
  resolved manifest items. `assertKnownCompositions` currently reads the **code
  seed** (`compositionsConfig.fields.manifests.defaultValue`) while compose-serve
  reads the **resolved layered config** — so a Studio-created composition (uuid
  id, user layer only) is servable today and would stop being if the serve path
  inherited the hermetic validator. Keep the code-seed variant for hermetic and
  give the serve path a resolved-config one, in `build-targets.ts`, with the
  divergence stated at both.

**Run ledger** — one row per invocation, N targets

> **The CLI cannot ORM-INSERT into a table whose drizzle definition has gained a
> column the DEPLOYED schema lacks.** Measured, after two failed builds — the
> earlier wording ("the CLI cannot write a column added by the same build") was
> wrong in a way that cost both of them, because it suggested that *omitting the
> field* was a fix. It is not.
>
> Two facts combine:
>
> 1. **Ordering.** `./equin build` mints its `build_runs` row
>    (`recorder.insertRun`, `bin/commands/build.ts:~1168`) *before*
>    `generateAppSources` (`:~1195`) generates the migration, and the migration
>    is not APPLIED until the backend restarts at the very end of the build. So a
>    CLI insert always runs NEW code against the schema the *previous* build left
>    behind.
>
> 2. **Drizzle names every column.** `db.insert(t).values({…})` emits the FULL
>    column list from the table definition and passes `DEFAULT` for the fields
>    the caller omitted. Verified with `.toSQL()`:
>
>    ```
>    insert into "build_runs" ("id","trigger","commit_hash","namespace","targets",
>                              "parent_id","started_at","finished_at","exit_code","pid")
>    values ($1,$2,$3,$4,default,default,default,default,default,$5)
>    ```
>
> So the hazard is the TABLE, not the field. An expand/contract shim column does
> **not** solve it: the previous attempt kept `target` and wrote it instead of
> `targets`, and the statement still named `targets` and still died with
> `column "targets" of relation "build_runs" does not exist (42703)`.
>
> **The fix is at the write site, and it is ONE build.** `insertRun` becomes a
> hand-written parameterised `INSERT` naming exactly the columns the CLI supplies
> (`id, trigger, commit_hash, namespace, pid`) — immune to every future column
> addition, not just this one. `targets` is simply not named for one release and
> takes its column DEFAULT (`{singularity}`), which is exact for a plain build and
> merely mislabels a terminal `--composition` build in that window. `target` is
> dropped in this same change; no shim column, no second migration.
>
> **DONE** — the migration is applied and deployed, so the follow-up landed:
> `insertRun` now names `targets` too. It is bound with `sql.param(r.targets)`,
> not `${r.targets}`: a bare array in a `sql` template is drizzle's `in (…)` list
> form and expands to one placeholder per element in parens, which Postgres
> rejects with `42804 … is of type text[] but expression is of type record`.
> The standing rule for this statement is add the column, deploy it, THEN name it.
>
> `closeRun` is unaffected — `.set()` names only the assigned columns, so the
> UPDATE is already skew-immune (verified with `.toSQL()`). It stays on drizzle.
>
> It did not bite before because the old `isMainBuild` gate meant only manual
> *main* builds wrote the ledger from the CLI; widening that to every checkout is
> what exposed it.

- `run-ledger/server/internal/tables.ts` (+ migration) — `target text NOT NULL
  DEFAULT 'main'` is REPLACED by `targets text[] NOT NULL DEFAULT
  ARRAY[MAIN_COMPOSITION_ID]`, i.e. `['singularity']`, in one change.
  The partial unique index
  collapses from `(namespace, target)` to `(namespace)` where `finishedAt IS
  NULL`: it existed to let main's row and its compose-serve children be open at
  once, and with no children left it says what the per-checkout `.build.lock`
  already enforces — one build in flight per namespace. `parentId` stays until
  Phase 8.

  **The `"main"` literal goes now, not in Phase 8.** It costs nothing: the sites
  that compare it are already in this diff (they are being rewritten to render
  chips through one helper), and the table already contradicts itself —
  `namespace` defaults to `MAIN_WORKTREE_NAME`, which *is* `"singularity"`, while
  `target` defaults to `"main"`, so every main build row says both today. The
  default becomes derived from `MAIN_COMPOSITION_ID` rather than spelled.

  Existing rows take the new default, so historical *composition* rows read
  `[singularity]` — mislabelled, not merely stale. Accepted: the history
  resource is a `LIMIT 50` window over a 50-row retention, so it rolls over
  within a day or two of normal building. A backfill from `target` in the same
  migration is possible but is not worth the extra step for build observability.
- `run-ledger/server/internal/recorder.ts` — `createBuildRunRecorder(namespace)`
  instead of the hardcoded `MAIN_WORKTREE_NAME`; `insertMainRun` →
  `insertRun({ id, targets, namespace, trigger, commitHash, pid })` (`targets` is
  named in the INSERT as of the follow-up — see the box above);
  `insertCompositionRun` and its sweep-close-by-target are deleted with the
  children they served. The insert itself becomes hand-written SQL naming its own
  columns — see the box above; that is what makes this ONE build instead of two. **A checkout's own DB may not exist** on a fresh checkout
  doing a composition-only build — degrade to a soft note, never fail the build.
- `plugins/build/core/resources.ts` — `BuildRunSchema.target` → `targets:
  z.array(z.string())`; `build-history-resource.ts` selects it.
- One helper in `build/core` answers "is this a plain main build?"
  (`targets.length === 1 && targets[0] === MAIN_COMPOSITION_ID`) so the six sites
  that compare `target === "main"` today (`build-button.tsx:62`,
  `build-popover-content.tsx:332,436`, `build-info.tsx:120`,
  `build-commits-section.tsx:21`, `use-serve-status.ts:67`) stop spelling any
  literal. The history rows and the detail pane render one chip per entry in
  `targets`. `build-commits-section`'s "Commits belong to the parent build"
  short-circuit is **deleted outright** — with no parent, a build's commits are
  about its tree, which every target shares.

This pulls Phase 8's *UI half* forward, which is the honest place for it: those
comparisons exist only because a composition build was a child row, and this is
the change that stops it being one. Phase 8 is then only `parentId` — the
`build-<parentId>-c-<composition>` artifact naming is gone here too, since one
invocation writes one `build-<buildId>` profile and log.

**Build server + UI seam**
- `plugins/build/server/internal/run-build.ts` — `triggerBuild(trigger,
  { composition })`; argv `--composition <id>`; the pre-spawn claim insert sets
  `targets: [composition ?? MAIN_COMPOSITION_ID]`. It still claims one in-flight
  slot per namespace, so a UI serve request during a live build is dropped as it
  is today.
- `plugins/build/server/internal/handle-serve-composition.ts` — drop `isMain()`.
- `plugins/build/plugins/serve-composition/shared/endpoints.ts` +
  `server/internal/handle-status.ts` — `serveStatusEndpoint` takes a **composition
  id** and returns the server-resolved `namespace` + `url`. The browser cannot
  compose the namespace: it does not know the serving backend's checkout.
  `canServe: true`.
- `.../web/internal/use-serve-status.ts` — delete the client-side
  `asNamespace(id)` cast (`serveUrl()`); take the URL from the response.
- `.../server/internal/reset.ts` — same cast; resolve through `namespaceFor`.
- `plugins/build/plugins/serve-composition/CLAUDE.md` — "the namespace is the
  item's `id`" is no longer true.

---

## Checks

- **`namespace:grammar-in-sync`** — the 63-byte cap changes the regex literal in
  three places (owner, gateway, `select-registry.ts`); all three in one commit.
- **`composition-closure`** — item 0 asserts every manifest id is a servable
  namespace; add the length rule so it fires at the manifest rather than at
  `CREATE DATABASE`. Its warning 7 ("would run against main's checkout under a
  non-worktree namespace") needs rewording — the checkout is now variable.
- **`cli:codegen-manifests-not-frozen`** — stays green only if `build-targets.ts`
  reads the compositions config **off disk** rather than importing it.
- **`web-artifacts:map-in-sync`** — becomes reachable-stale: a composition-only
  build runs codegen + format (mutating the tree) without republishing ckNs's
  dist. `isBuildInProgress()` skips it during the build and `push` uses
  `--scope tree`, so it only bites on a bare `./equin check`. Documented
  consequence, and arguably the correct loud signal.
- **`plugins-registry-in-sync`** — unaffected, and it is what proves the main
  composition's registry equals the committed one.

New: nothing. The 63-byte rule belongs at the minter (a throw in `namespaceFor`),
and the presence hazard is removed by making selection explicit rather than
guarded — both are higher rungs than a check.

---

## Known consequences (state, don't hide)

1. **`autoBuild` stores intent nothing acts on** until Phase 6 wires triggers.
   The Serve button still builds immediately; only the "every main build
   refreshes them" behaviour is gone. The serve panel copy that says "the next
   main build stops serving it" is now false (the model doc already flags this).
2. **Filtered registries accumulate in every checkout that ever served
   something** — `listNamedCompositionRegistries` was the sweep's only consumer.
   Gitignored, but they are `tsc` input. Phase 5's reclaim trigger owns this.
3. **Agent-worktree builds start minting `build_runs` rows** (today `isMainBuild`
   gates every recorder write). An improvement, but visible in every worktree's
   Build UI and in `hasLiveInflightBuild`.
4. **`hasLiveInflightBuild` is target-blind**, so a live composition build makes
   the UI silently drop a main auto-build request in the same checkout. Correct —
   the per-checkout `.build.lock` serializes them anyway — but name it rather
   than "fixing" it by scoping the lock.
5. **Historical composition rows read `[singularity]`** after the migration —
   see the run-ledger section. Accepted deliberately (50-row window, 50-row
   retention); the alternative is a backfill from `target` in the same migration.
   Rows the CLI minted during the one release before it named `targets` also read
   `[singularity]` — same reason, same shelf life. The INSERT names `targets` now,
   so newly minted rows are exact.
6. **The manifest source flips** from main's user layer to the checkout's, so a
   Studio-created composition on main is invisible from a worktree until its
   config propagates. Intended by the model doc.
7. **A composition served from a worktree is pinned to that worktree's tree**
   (`spec.server`). Deleting the checkout strands it; the gateway evicts on
   `serverPathMissing`, so it degrades to a 404, but the DB and dist survive.
   Phase 5.
8. **`experimental` (the red frame)** becomes `checkout.kind === "worktree"` —
   byte-identical on main, and correct for a composition served from a worktree.
9. **`zeroCacheSpec` is now passed for every target** rather than omitted for
   compositions. Free when the `SINGULARITY_ZERO_CACHE` opt-in is off; under the
   opt-in each composition namespace gets its own sidecar, which is the right
   behaviour and one fewer special case.

---

## Verification

Land in three commits, each green on `./equin check`:

1. **Registry selection.** After landing: `./equin build` from a worktree is
   byte-equivalent to today's; `bun ./equin test
   plugins/framework/plugins/server-core` covers `select-registry.test.ts`
   (extended with the fail-loud arm); drop a stray
   `server.composition.singularity.generated.ts` into main's `server-core/core/`
   and confirm main's backend still boots the committed registry;
   `./equin build --hermetic --composition singularity` now succeeds.
2. **Namespace cap + DB grammar.** `bun ./equin test
   plugins/infra/plugins/namespace`; `namespaceFor` throws over 63 bytes.
3. **The fan-out.**
   - `./equin build --composition sonata` **from this worktree** →
     `http://sonata.<checkout>.localhost:9000` renders, with `psql` showing a
     database named `sonata.<checkout>` and a `composition.json` marker carrying
     `{ composition: "sonata", checkout: "<checkout>" }`.
   - Same command **on a host where main has not been built** — the
     `readFleetVendorMeta` throw is what this proves gone.
   - `./equin build --composition sonata website` — two namespaces, **one**
     `build_runs` row rendering `[sonata] [website]`, one transcript, one
     profile, and the second target's artifact counts showing reuse rather than
     rebuild. Then run the two sequentially and confirm **two** rows.
   - `./equin build` with no flag — deploy receipt at
     `~/.singularity/worktrees/<checkout>/build-status.json` reads `status: ok`,
     and the build profile's span list is unchanged span-for-span.
   - Studio → Compositions → **Serve** from a worktree: the toggle is enabled,
     the build runs, and the panel's live-URL chip points at
     `sonata.<checkout>.localhost:9000`.
   - Kill a two-target build mid-second-target (SIGTERM) and confirm exactly one
     verdict is printed, one row is closed, the first target's receipt is
     terminal, and the second's reads `interrupted`.
   - `./equin check migrations-in-sync` after the `targets` migration, and
     `query_db` on `build_runs` to confirm the column is `text[]` and that a
     fresh plain build lands `{singularity}`. Confirm `target` is gone and no
     code path writes `main` any more (`rg '"main"' plugins/build` should return
     nothing target-shaped). The CLI's INSERT names `targets` now, so confirm a
     terminal `--composition sonata` build lands `{sonata}`, not `{singularity}`.

Use `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts
--url http://sonata.<checkout>.localhost:9000` for the render check rather than a
blind snapshot.
