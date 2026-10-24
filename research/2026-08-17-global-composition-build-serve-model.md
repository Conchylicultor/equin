# Composition build & serve model — vision and phased plan

## Context

A composition is a named subset of plugins. Today they are second-class: the main
app is not one, the CLI has three overlapping ways to build one, serving a
composition requires a full main build, and a composition namespace can only
exist on main. The result is that "build sonata" is not a thing you can do — you
build main and sonata falls out of it.

This doc states the target model and the order of work to reach it. Each phase
below becomes its own task and writes its own plan; nothing here is a detailed
design.

Companion doc (the user-facing mental model this refines): the "Build, serving"
page, block `block-b4f38ca7-b710-4003-a206-cd9b8d25d091`.

> **Revision (same day).** The phase list was reshaped after review. Vendor
> resolution caching has landed. The build-UI parent/child linkage phase was
> dropped — it patched a symptom this model deletes — and became a cleanup at the
> tail. The vendor-set decoupling and worktree-scoped serving were merged into
> the serve phase, since all three rewrite the same code path.

---

## Target model

**1. A composition is the unit of building. The main app is one of them.**

`singularity` becomes an ordinary manifest entry whose closure is what
`web.generated.ts` covers today. There is no "main build" path — only
`build --composition <name>`, with `singularity` as the default when no flag is
given. Every property that holds for `sonata` holds for `singularity`.

**2. Namespace = `<composition>.<checkout>`.**

Flat directory names under `~/.singularity/worktrees/`, no nesting:

| composition | checkout | namespace | URL |
|---|---|---|---|
| singularity | main | `singularity` | `equin.localhost:9000` |
| sonata | main | `sonata` | `sonata.localhost:9000` |
| singularity | att-XXX | `att-XXX` | `att-XXX.localhost:9000` |
| sonata | att-XXX | `sonata.att-XXX` | `sonata.att-XXX.localhost:9000` |

`singularity.` and the main checkout suffix are elided, which preserves every
URL in use today. The residual ambiguity — is `foo` the composition `foo` on
main, or `singularity` on checkout `foo`? — is resolved by one rule: **a known
composition id wins, and a checkout may not take a composition's name.** That
collision guard already exists in spirit (compose-serve refuses to write into a
spec dir lacking a `composition.json` marker); it needs generalizing, not
inventing.

**3. One CLI verb.**

```
build                                   # = build --composition singularity
build --composition sonata              # deploy sonata into the dev cluster
build --composition sonata website      # union build; artifacts shared via the store
build --composition sonata --hermetic   # portable artifact set, no cluster contact
```

`--hermetic` is a posture, not a single effect. It selects the release dist
target, materializes real bytes instead of symlinks, writes no `spec.json`,
skips every cluster interaction (Postgres, DB fork, gateway, run ledger), and
runs the fast validation set rather than the full checks pass.

Removed: the separate artifact-only verb (gone in Phase 2), `build
--serve-composition`, and any standalone `--materialize`.

**4. Vendor sets are per-composition, shared by content address.**

No global superset. Each composition resolves its own vendor set; two
compositions with identical dependencies share the bundle automatically because
sets are keyed by `setHash` under `~/.singularity/web-artifacts/vendors`.

**5. Deactivating a composition stops auto-building it. Nothing is swept.**

The existing dist, spec and database stay live until explicitly removed. There
is no deactivation sweep.

**6. A composition build has no parent.**

`build --composition sonata` mints its own run: its own id, `target: "sonata"`,
no parent, artifacts named after itself. The current parent/child shape exists
only because compose-serve is a tail stage of a main build.

---

## Where we already are

The artifact engine already matches the target model. What is missing is the
identity model and the CLI surface.

Already true:

- Per-plugin, content-addressed, cached artifact builds, shared across worktrees
  (`web-artifacts/core/internal/store.ts`, `pipeline.ts`). Building N
  compositions builds the union once.
- Composition-only builds that need no main build — the hermetic path plans
  from `compositionFleetSource()` and resolves its own vendor set, by design, so
  it runs on a bare host from a fresh clone. **The hermetic path already
  satisfies target-model point 4**; only the serve path reuses main's set.
- Hermetic output (`materialize: true`), and its dist path
  `worktrees/<checkout>/release-web/<composition>`.
- `worktrees/singularity/web`, `worktrees/sonata/web`, `worktrees/<worktree>/web`.
- **Vendor resolution caching — landed.** It previously ran uncached and
  sequential before the store check, costing 35–110 s on builds where nothing was
  stale.

Not true yet:

- `singularity` is not a composition; main builds from the committed full registry.
- The gateway rejects multi-label namespaces (`parseWorktree` returns `""` when
  the name contains a `.`), so `sonata.att-XXX` cannot be served.
- Serving a composition requires a full main build, because compose-serve reuses
  main's vendor set via `readFleetVendorMeta`, which throws unless the whole
  fleet is in the store.
- Composition serving is main-only, gated in three places.

---

## Phases

Ordered by dependency. Phases 2 and 4 are the two halves of the CLI story and
are deliberately split at the artifact/deployment seam: the hermetic half needs
no namespace, the serve half does.

### Phase 1 — `singularity` becomes a composition

Add the manifest entry whose resolved closure equals today's full registry, and
make `build` with no flag mean `--composition singularity`. Removes the special
case at the root and unblocks Phases 2, 4 and 7.

**Files.** `plugins/plugin-meta/plugins/composition/core/config.ts`, the
registry-gen path in `tooling/plugins/codegen/core/`.

**Risk to watch.** Adding an entry bumps the rendered config origin hash, which
can stale an existing user-layer `compositions.jsonc`. Land alone.

### Phase 2 — One build verb: the artifact half — **LANDED**

`build` took `--composition <name...>` (variadic) and `--hermetic`, and the
separate artifact-only command was deleted. Nothing here needed a namespace —
hermetic writes no spec — and nothing needed the vendor change, because the
hermetic path already resolves its own set. Plan:
[`2026-08-18-cli-one-build-verb-artifact-half.md`](./2026-08-18-cli-one-build-verb-artifact-half.md).

The behaviors that distinguished the two commands are `--hermetic`-conditional:
dist target, materialize, `experimental` marker, checks depth, branch guard,
gateway restart/health probe, `build_runs` row + profile + progress log + verdict
guard, Postgres readiness and DB fork. The branch is the literal first statement
of `build`'s action, into `internal/hermetic-build.ts`, so "no deploy machinery
is armed" is structural rather than ~20 scattered `if (!hermetic)` guards.

Two contracts preserved:

- **Migration exit codes.** `release` depends on stage 2 exiting `2` on a
  drizzle rename/create prompt and `1` on a missing `--migration-name`. Nothing
  on the hermetic path installs an exit hook, signal handler or verdict guard,
  so nothing can rewrite or bury them.
- **`release` keeps shelling out to a subprocess.** It statically imports plugin
  barrels at module load, so it needs a fresh, unfrozen process. Only the argv
  changed (`--hermetic` before `--composition`, because commander's variadic is
  greedy to the next flag).

Decisions settled while landing it:

- **`--composition` without `--hermetic` refuses, exit 1, naming Phase 4.** The
  two flags stay orthogonal *in meaning*, so Phase 4 deletes a guard rather than
  re-plumbing a flag whose meaning silently flipped.
- **`--hermetic --composition singularity` refuses, exit 1.** It would emit
  `server.composition.singularity.generated.ts` into the checkout, and
  `select-registry.ts` picks that file for main's backend on its next spawn
  purely on file *presence*. Byte-identical today only by the equivalence
  `plugins-registry-in-sync` proves — "safe by coincidence, created by a path
  nobody expects" is how the pre-S1 checkout-global registry bug worked.
  Consequence: **releasing the main app is currently impossible**, a real
  capability gap Phase 3/4 must reopen (stop emitting into the checkout, or make
  `selectRegistry` require more than presence).
- **`--composition X Y` fails fast** — the first failure exits 1, naming what was
  published, what failed, and that later compositions were not attempted.
  Compositions in one invocation share a plugin union, so a second failure is
  almost always the same failure re-derived, and nothing published is lost.
- **The guard was replaced, not deleted** — but not with the property it claimed.
  `cli:build-composition-import-subset` compared two command files' module sets;
  measured on the tree, `bin/cli.ts` already statically reaches 14 plugin server
  barrels through `release.ts`, so "no plugin barrel in the CLI's static closure"
  was false then and always had been. A frozen *barrel* is harmless while
  everything it reaches is stable; the hazard is its **generated inputs** changing
  mid-run. `cli:codegen-manifests-not-frozen` (`alwaysRun`) therefore asserts that
  no module in the CLI **process**'s import closure reaches a registered
  pre-barrel or post-web codegen manifest — a manifest frozen at CLI load is
  rewritten on disk by stage 2 and never re-read, so `generateConfigOrigins` sees
  the previous run's descriptor set and `pruneOrphanedConfigFiles` deletes a
  freshly-authored config override. Registry-phase outputs
  (`check.generated.ts`, `data-dirs.generated.ts`, `auto-stubs.generated.ts`) are
  in the closure and are rewritten by stage 1 — out of scope on purpose:
  loud-or-benign, not silent data loss. Worth its own task.
- **The hermetic child now installs the orphan guard**, because `build` is in
  `OP_COMMANDS` and membership is keyed on `process.argv[2]` before flags are
  parsed. Under `release` its ppid is release's, so it fires only if release
  itself dies — exactly when dropping `.build.lock` is right. The original
  justification for staying out was the `bun --inspect` re-exec, removed
  2026-07-28.

**Files.** `cli/bin/commands/build.ts`, `internal/hermetic-build.ts` (new), the
deleted artifact-only command, `cli/bin/cli.ts`, `cli/check/index.ts`,
`internal/app-artifacts.ts` (`prepareCompositionSources` went variadic;
`compositions: []` is a plain build).

### Phase 3 — Namespace identity

One function, `namespaceFor({ composition, checkout })`, owning the elision rule
and the collision guard; every writer and reader derives from it. Then the
gateway change: drop the dot rejection in `parseWorktree` and widen the name
regex in `registry.go`.

**Files.** a core plugin for the rule, `gateway/proxy.go`, `gateway/registry.go`.

**Verify first.** That two-label `*.localhost` resolves in the browsers actually
used. It is the one piece not under our control, and it can change the design.

### Phase 4 — One build verb: the serve half

`build --composition sonata` (non-hermetic) builds and serves one composition on
its own, from any checkout. Merges three previously-separate pieces that all
rewrite the same path:

- **Per-composition vendor set.** Drop `readFleetVendorMeta` reuse — the change
  that removes the main-first coupling. Note why the shortcut existed: a served
  dist *symlinks* the vendor set dir, so a superset costs nothing on disk,
  whereas a hermetic dist copies it whole.
- **Any checkout.** Drop the three main-only gates, read the *worktree's*
  resolved compositions config rather than `singularity`'s, and point the spec's
  `server` path at the worktree's server-core. Databases become one per
  (composition × checkout).
- **Delete `--serve-composition` and the compose-serve stage.** With
  `--composition` doing the work directly, the tail-stage mechanism has no
  remaining caller.

Open question this phase owns: does `build --composition X Y Z` mint one run row
or three? Three siblings of one invocation is a different relation from today's
parent/child and may still want grouping in the UI.

**Files.** `cli/bin/commands/build.ts`, `internal/compose-serve.ts` (deleted),
`plugins/build/server/internal/handle-serve-composition.ts`.

### Phase 5 — Reclaiming a composition namespace

Nothing reclaims a composition's dist, spec and database. Deactivation
deliberately keeps them (target-model point 5), and deleting a checkout strands
the namespaces derived from it — `debug/worktree-cleanup` knows about git
worktrees and DB forks, not namespaces named after them. Worse once namespaces
are per (composition × checkout).

Needs a decision on what the reclaim trigger actually is, given deactivation is
explicitly not one.

### Phase 6 — Deploy triggers in the Composition UI — **LANDED**

`autoBuild: bool` became `serve: enum(off | manual | push | hourly | daily |
weekly)`, so "rebuild on push but not served" has no spelling. A mode's whole
content is a **rate limit**, which is what lets every edge evaluate every mode
through one predicate — no push-specific plumbing, no cadence-specific edge. Plan:
[`2026-08-20-global-composition-deploy-triggers.md`](./2026-08-20-global-composition-deploy-triggers.md).

Decisions settled while landing it:

- **The change signal is the deployed commit vs HEAD, not the inputs hash.** The
  marker already records the commit its build ran from, so the gate is free,
  never skips a needed build, and covers everything a rebuild moves — dist,
  server tree, migrations, config. A closure-scoped inputs-hash gate would have
  been a second implementation of "what is in this composition", drifting from
  the build's own, and blind to server/migration changes: a served composition
  would keep running old server code after a push. The inputs hash still does its
  job INSIDE the build, where an unchanged closure means every artifact is a
  cache hit.
- **A composition reuses `wantsBuild` verbatim**, with the marker as its single
  `web` carrier — so converged-⇒-no-build and termination are one policy, tested
  once. The rate limit is the only clause the mode adds.
- **An automatic trigger never MINTS a namespace.** A marker-less composition is
  skipped; pressing Serve is the only thing that may claim one.
- **Main only**, both halves of the loop, matching `refAdvanced`'s own scope.
- **Rebuild now is available in every mode.** The commit gate is blind to an edit
  of the composition's own manifest row (contributors, entry points, `extends`),
  which changes what should be served without moving HEAD. Closing that needs a
  second termination axis (`BuildAttempt` records a commit, not a digest) — a
  follow-up, not this phase.

The stale panel copy this phase was to fix ("the next main build stops serving
it") had already gone in Phase 4; what was left was prose still naming Phase 5's
reclaim as future work.

**Files.** `plugins/plugin-meta/plugins/composition/core/serve-mode.ts` (new),
`plugins/build/server/internal/{composition-trigger,wants-build,composition-tick-job}.ts`,
`plugins/build/plugins/serve-composition/`,
`plugins/apps/plugins/studio/plugins/compositions/`.

### Phase 7 — Deprecate plugin disabling

Replace `singularity.disabled` in package.json with composition excludes.

**Unresolved, and must be settled first.** The two are not the same operation.
Disabling seeds a *reverse* closure — `computeDisabledIds` pulls in descendants
∪ every transitive importer, so disabling X removes everything that imports X. A
composition is purely *additive*: `bundle = hardClosure(entrySeeds ∪
selectedContributors)`, and a `!` negative can only trim ids pulled in
implicitly by a `.**` glob — never an explicit positive, never a hard dependency.
So excluding X while something in the closure imports X yields either a broken
bundle or a silently-ignored exclude. Decide: cascade importers out, or refuse
the exclude loudly.

Second wrinkle: the disabled filter is applied unconditionally in codegen
precisely so the `*-in-sync` checks stay green off committed source. Making it
composition-scoped makes the committed registries composition-dependent.

**Files.** `tooling/plugins/codegen/core/disabled-ids.ts`,
`plugin-meta/plugins/closure/core/resolve-composition.ts`.

### Phase 8 — Remove the vestigial parent/child concept — **LANDED**

`build_runs.parent_id` is dropped, and target-model point 6 is now true of the
schema rather than only of the write path. Plan:
[`2026-09-09-global-build-runs-drop-parent-child.md`](./2026-09-09-global-build-runs-drop-parent-child.md).

Two of this phase's three bullets had already been absorbed by Phase 4, which is
worth recording because the phase was written expecting to do them:

- **Artifact naming was already clean.** Answering Phase 4's open question with
  *one invocation is one row* removed the child id, so nothing was left to
  rename — no `-c-<name>` suffix survives in live code, and a build id is just
  `<shortCommit>-<timestamp>`.
- **The `target === "main"` special-cases were already gone**, replaced by the
  single answer `isMainCompositionBuild(targets)` when `target` became `targets`.

So what actually remained was the column, its wire field on `BuildRunSchema`, and
two orphaned CLI factories — `createSpanCollector` / `createStepLogCollector`,
which existed so a child could write artifacts under its own id and lost their
only caller when Phase 4 deleted the compose-serve stage.

The build UI was left alone, per this doc's own revision note: with no parent
relation to render, the detail pane has nothing to link to.

---

## Verification

Per phase, but the end-to-end target:

1. Building sonata alone from an agent worktree, on a machine where main has
   **not** been built, succeeds and serves `http://sonata.att-XXX.localhost:9000`.
2. Building sonata and website together builds both, and the second's artifact
   count shows reuse rather than rebuild.
3. A hermetic sonata build on a fresh clone with a cold store produces a
   relocatable dist containing only sonata's vendors.
4. A no-flag build is byte-equivalent to today's main build.
5. A composition's `build_runs` row has no parent and its artifacts are named
   after its own id.
6. `./equin check` green throughout, in particular `migrations-in-sync`,
   `plugins-registry-in-sync`, `web-artifacts:map-in-sync`, and
   `cli:codegen-manifests-not-frozen` (Phase 2's replacement for the old
   import-subset guard).

## Open decisions

- Namespace: elision (recommended, preserves every current URL) vs uniform
  `singularity.att-XXX`. Phase 3 blocks on this.
- Phase 7's importer-cascade semantics.
- Phase 5's reclaim trigger, given deactivation is explicitly not one.
- Whether `--composition X Y Z` mints one run row or three (Phase 4).
