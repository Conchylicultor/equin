# cli

The `./singularity` agent CLI. `bin/index.ts` is the bootstrap; `bin/cli.ts` is
the CLI proper.

## Contributing a command

A plugin ships `plugins/<name>/cli/index.ts` default-exporting
`defineCliCommand(…)` (from `@plugins/framework/plugins/cli/core`), and
`./singularity build` regenerates `core/cli.generated.ts` from the filesystem.
Nothing here names it. `plugins/format/` is the reference shape.

Deleting a command is just deleting its folder. Until the registry is
regenerated it still lists the command; `bin/cli.ts` skips an entry whose
`cli/index.ts` is gone (one stderr line names it) instead of failing startup, so
`build` / `push` can run to regenerate it. A declaration that is present but
throws still fails startup loudly.

The declaration is **data only** — commander needs names and flags before it
parses, so every plugin's `cli/index.ts` loads on every `./singularity`
invocation, `build` included. The implementation sits behind the declaration's
own `run: () => import("./run")` and loads only when that command runs.
`cli:command-declarations-light` enforces the split (no npm package, no
`web`/`server` barrel, measured with dynamic edges cut); breaking it silently
taxes every other command. `bin/register-commands.ts` is the sole translation
into commander calls, which is what keeps `commander` — a workspace-local dep —
out of contributing plugins.

A `cli/index.ts` with no default export is not a command; that is how shared CLI
machinery lives in a `cli/` barrel other commands import.

A command sub-plugin has no runtime barrel, so its generated doc line comes from
its **`package.json` `description`** — set it, or the plugin lands in
`docs/plugins-compact.md` (auto-loaded into every agent) with a blank line.

**Every command is a sub-plugin; `bin/` holds no command at all.** It is now just
the host: `index.ts` (bootstrap), `cli.ts` (the program), `register-commands.ts`
(the one translation into commander) and `run-cli.ts` (the process-boundary
harness). Five sub-plugins carry what more than one command needs, and a command
reaches them through their `cli/` barrels:

| sub-plugin | what it carries |
|---|---|
| `bootstrap` | `ensureDeps`, the post-install re-exec, the orphan guard, the build lock — **the npm-free closure**, loaded before `bun install` |
| `op-runtime` | broadcasts, deploy receipt, fatal-signal exits, lane, op profiler, progress log, admission valve, nested check, build output |
| `migrations` | drizzle generation and the interactive prompt driver |
| `git-artifacts` | re-deriving generated artifacts after a merge driver, and installing the drivers |
| `doctor` | `assertPrerequisites` — the prerequisite doctor (`doctor.sh`, also `mise run doctor`) as the first step of `start` and a deploying `build` |

A command's own ordered *stage sequence* lives in its own `cli/internal/` —
build's eight-file pipeline is build-private, and `converge-script` is deploy's.

## Commands

| command | what it does |
|---|---|
| `build` | **Deploy this checkout into the live dev cluster** — its own app, or the compositions named by `--composition <name…>`, each at `http://<composition>.<checkout>.localhost:9000` — *or* — `--hermetic --composition <name…>` — **produce those compositions' artifact sets on a bare host from a fresh `git clone`.** The deploy posture is the inner loop: artifacts + Postgres readiness, the DB (the worktree fork for the checkout's own app, an empty one per composition), the `build_runs` ledger, gateway spec/restart/health probe; it needs a provisioned dev box. The hermetic posture is filtered registries + generated migration SQL + the web dist, as a function of (source tree, compositions) only — no cluster, no gateway, no ledger. |
| `release` | Wraps `build --hermetic` and packs its output into a portable self-contained app (`--target web` / `tauri`). |
| `check` | Run the repo validation checks. **The only in-process caller of `runChecks()`** — `build` and `push` both SPAWN this command via [`plugins/op-runtime/cli/check-subprocess.ts`](plugins/op-runtime/cli/check-subprocess.ts) (read its docblock), so their two `checks ✓` are one claim and the global cache stays honest. |
| `test` | Run tests under the given paths (default: whole `plugins` tree) through **both** runners sequentially (`bun test`, then `vitest run`), then summarize both buckets — an empty one is stated, not implied, because either runner alone is green-but-partial. Paths only; no flag forwarding. |
| `push` | Checks → merge the worktree branch back into main → push. |
| `format` | Prettier over the `.ts`/`.tsx` changed on this branch — the same pass `build` runs, in seconds. It exists because `push` never builds, so a `format-clean` failure would otherwise cost a full build. |
| `regen-generated` / `regen-migrations` | The repo-tree codegen and migration-generation pipelines as standalone commands (used by the normalize pass). |
| `normalize-generated` | Marker-gated repair of generated artifacts a merge driver auto-resolved. Invoked by the `post-rewrite` hook; rarely run by hand. |
| `serve-app` | Runtime entrypoint a released bundle's launcher invokes. |
| `db` / `start` / `stop` | DB fork/list/drop admin; the one-time gateway bring-up (a launchd service on macOS, so it comes back after a reboot) and its stop. |

The **orphan guard** (`plugins/bootstrap/cli/orphan-guard.ts`) is armed by `bin/index.ts` for
EVERY invocation, before the install: a CLI process exits once its invoking shell
dies, so it can never sit on a host lock (the push mutex, worst case) or on the
install lock. There is no op-command set and `bin/index.ts` reads no argv — a CLI
whose commands are plugin contributions cannot keep such a list, because the
bootstrap runs before the install that would let it load the declarations.

The opt-out is declared, not inferred: a command meant to outlive its shell sets
`detachable: true` and the mapper disarms the guard as it starts. The spawner-set
`SINGULARITY_BUILD_DETACHED` escape still covers the detached self-restart build,
which is knowable pre-install because it is env.

A **hermetic** build (`build --hermetic`) is therefore guarded like everything
else — an orphaned one exits instead of sitting on `.build.lock`. Under `release`
the guard is inert (the child's ppid is release's), so it fires only if release
itself dies, which is exactly when dropping the lock is correct. Nothing else the
deploy posture arms (progress file, op profiler, run recorder, worktree-op
markers, exit hooks, verdict guard, deploy receipts) exists on that path; see
`plugins/build/cli/internal/hermetic-build.ts`.

Op commands used to additionally re-exec themselves under `bun --inspect` so the
op-wedge watchdog could attach a profiler. Both the watchdog and the re-exec were
removed 2026-07-28 (every wedge the watchdog ever reported was a false positive —
`research/2026-07-28-global-retire-op-wedge-watchdog.md`), so an op is now a
single process, not a wrapper/worker pair.

## Generated artifacts across a merge

`.gitattributes` routes every generated file (registries, plugin docs, plugin
`CLAUDE.md` autogen blocks, config origins, drizzle migrations) to a merge driver
in `scripts/`. A driver does the CHEAP half — take the upstream side, drop a
marker in `$GITDIR/singularity-merge-markers/` — because the file is a pure
function of sources git just merged correctly. `plugins/git-artifacts/cli/normalize-generated.ts`
is the other half: re-derive from the merged tree, amend, consume the marker.

It is deliberately NOT push-owned. `.githooks/post-rewrite` runs it after any
rebase (so a manual `git rebase origin/main` self-heals), `push` runs it around
its own rebase with the hook suppressed (`SINGULARITY_SKIP_POST_REWRITE`, because
push installs the rebased lockfile first), and `build` reaches the same state by
regenerating everything and clearing the markers itself. `core/` holds the marker
names + conflict scan so the `generated-artifacts-normalized` check reads the
same facts.

Plugin `CLAUDE.md` is the one mixed file, and its driver (`regen-claudemd.sh`)
is the one that can FAIL: it empties the autogen block on all three sides before
a real 3-way merge of the prose, so the block cannot conflict, and a prose
conflict exits non-zero — git marks the path `UU` and stops the rebase on it,
with ours/base/theirs labels (`%S %X %Y`). It must never exit 0 over markers:
git would stage them as a clean merge and `rebase --continue` would commit them.

**Push's post-rebase call passes `force`, and skips the marker gate.** No marker
is supposed to mean the drivers never fired, but it is equally what a marker
delivered somewhere unread looks like — and for an ordinary branch the two are
indistinguishable in effect (main's artifact already matches the merged sources),
while for a branch that edits a GENERATOR the second one hands the checks a
commit whose doc contradicts its own code
([`research/2026-08-19-global-push-normalize-generated-doc-drift.md`](../../../../research/2026-08-19-global-push-normalize-generated-doc-drift.md)).
The hook stays marker-gated: it fires after every rebase anyone does and has to
stay cheap, whereas push is already minutes long and has to be right. Forced, the
marker list also can't say which pipelines to run, so both do.

**`data/meta/_journal.json` is derived but stays TRACKED, on purpose.** A merge
driver only runs when a path is modified on both sides. Every other artifact
under the `regen-migrations` patterns is named `<ts>_<sha8>__<slug>`, so two
branches never touch the same one — the journal is the only file every migration
appends to, and therefore the only thing that fires the `migrations` marker.
"Both sides added a migration" ⇔ "journal both-modified" ⇔ "a snapshot-chain
Y-fork is possible", which is exactly the predicate the `--reset-migration`
repair needs. Gitignore it and the entire migration normalization pass stops
running (and drizzle-kit silently recreates an empty one). It does NOT cover
schema drift — main changing `schema.ts` without a migration is one-sided;
`migrations-in-sync` is what fails there.

## Dependencies: `plugins/bootstrap/cli/ensure-deps.ts` is the only install

`ensureDeps()` owns "this checkout's `node_modules` is correct for its inputs":
freshness-gated on a `(mtimeMs,size)` signature stamped in
`node_modules/.singularity-deps` (so the common case is ~140 ms and silent),
serialized on `.install.lock`, and **loud** — it runs `bun install` with output
passed through and throws a message naming the phase on failure. Every install
site routes through it: the `bin/index.ts` bootstrap, `mise.toml`'s setup task,
`app-artifacts.ts` stage 1, and `push`'s post-rebase install (`frozenLockfile:
true`, so a mid-push tree is never re-resolved). No bare `bun install` remains:
one skipping the lock races `clonefileat`, one skipping the stamp makes the next
process reinstall from scratch.

**A process that found `node_modules` stale must not then resolve an npm
package — it re-execs** (`plugins/bootstrap/cli/reexec.ts`, on any
`EnsureDepsResult` kind but `fresh`). Bun's resolver caches directory listings
from process start, so a process cannot see a `node_modules` that changed after
it started — every workspace-local one (`commander` under
`plugins/framework/plugins/cli/`) was already cached absent. Who installed is
irrelevant: waiting on `.install.lock` while another command installs
(`installed-by-other`) is as stale as installing. The dynamic `await import("./cli")`
fixes *when* resolution happens, the re-exec fixes *which process* does it; both
are required, and `cli:bootstrap-package-free` measures only the first.

**`./singularity` is a bare `exec` — never add a step above it.** It used to run
`bun install --silent` first; a failed install (bun 1.3.13 has no install mutex,
so concurrent installs in one checkout race on `clonefileat`) aborted the wrapper
under `set -e` before `exec`, printing nothing, so *every* subcommand read as
having failed on its own. Nothing may run before the CLI process, because only
the CLI process can attribute its own failures.

**`bin/index.ts` may never statically import an npm package** — node builtins,
relative files and `@plugins/*` only. Static imports hoist above the install, so
`import { program } from "commander"` there would resolve against the
`node_modules` `ensureDeps` exists to repair. That is the whole reason `cli.ts`
exists and why the bootstrap ends in `await import("./cli")`; the orphan guard
arms first, so an orphaned op can never sit on the install lock. Enforced by the
`cli:bootstrap-package-free` check — if you need a package, put it in `cli.ts`.

Lock order is one-way: **`.build.lock` → `.install.lock`**, never the reverse
(nothing takes the build lock while holding the install lock), so no deadlock.
The install lock is not `.build.lock` itself on purpose — sharing them would make
a `./singularity check` block for an entire concurrent build.

## Locks: the kernel owns them (`plugins/bootstrap/cli/checkout-lock.ts`)

Both locks are an exclusive `flock(2)` on a regular file, via
`packages/flock`, taken through one `acquireCheckoutLock` (required `what` names
the lock in every wait line). The kernel drops the lock when the fd closes **or the holder
dies** — SIGKILL and OOM included — and no pid is consulted, so PID reuse cannot
confuse it.

Two rules that look wrong and are not:

- **The lock file is never unlinked.** Release is `closeSync`. The fd *is* the
  lock, so there is nothing to delete, and an unlink could only ever remove a
  successor's lock.
- **The pid written into the file is diagnostics only.** Nothing reads it back to
  decide ownership. Do not reintroduce a `kill(pid, 0)` probe or a heartbeat: a
  heartbeat proves the event loop turns, not that the build is progressing, so a
  build wedged on a hung child looked healthy under the old scheme. "What is the
  holder stuck in?" is answered instead from `~/.singularity/logs/build-progress/build-progress.jsonl`,
  which records the actual span.

## The deploy receipt (`plugins/op-runtime/core/internal/build-receipt.ts`)

`~/.singularity/worktrees/<wt>/build-status.json` — `running` once the build lock
is granted, rewritten `ok` / `failed` / `superseded` in `finalizeBuild`. **One
fixed path, deliberately with no `<buildId>` variant**: every other build artifact
is per-run, so "did my build land?" could only be asked of them through
`ls -t build-*.log | head -1`, which answers with a *previous* run's `BUILD OK`
whenever the current one was killed before writing its own.

A SIGKILLed build runs no handler, so it leaves the receipt at `running` with a
dead pid — which `resolveReceipt` reports as `interrupted`, and which `build`,
`check` and `push` each announce at startup via `reportInterruptedPredecessor`.
That is the only trace such a build leaves: it printed no verdict (the
`installVerdictGuard` backstop cannot run) and its exit status is invisible behind
a pipe.

The receipt is opened **after** the lock, not before — the lock serializes builds
in a checkout, so exactly one build owns the receipt at a time and a build that
dies while still queuing cannot overwrite its predecessor's.

**A killed build and a build that failed its checks both write
`status: "failed"`** — what separates them is `exitCode` (`128+signo` vs `1`)
plus `signal`, stamped the moment a catchable signal arrives rather than only at
the terminal rewrite, so an *escalating* kill (SIGTERM then SIGKILL: `timeout -k`,
most supervisors) still records the SIGTERM on the `running` receipt the SIGKILL
strands. Do not "simplify" that early stamp away.

The signal→exit-code map is [`plugins/op-runtime/cli/fatal-signals.ts`](plugins/op-runtime/cli/fatal-signals.ts)
(`installFatalSignalExit`), shared by all three op commands. Its `afterInstall`
seam is load-bearing: **Bun installs its `sigaction` lazily on the first
`process.on(sig)` and does not chain**, so a native handler for these signals
must be armed strictly after that loop or it is silently overwritten.

## The artifact / deploy seam

`--composition` once meant "deploy this checkout, but filtered" — so cutting a
release required a machine that was already a Singularity dev box, and the
artifact was a function of the developer's environment rather than of the source.
The flag is back, and the split it was missing is a **posture** of the one verb
rather than a second command: `build --hermetic --composition <name…>` is the
artifact half (bare host, fresh clone, no cluster contact, N compositions per
invocation), plain `build --composition <name…>` is the deploy half — it builds
those compositions AND serves them into the dev cluster from whatever checkout
you are standing in, at `http://<composition>.<checkout>.localhost:9000`, each
with its own dist and its own empty database.

The two postures read DIFFERENT manifest documents, and that divergence is
deliberate: hermetic validates against the **code seed**
(`compositionsConfig.fields.manifests.defaultValue`, `assertKnownCompositions`)
because a release is a function of the source tree, while the deploy posture
reads this checkout's **resolved layered config**
(`plugins/build/cli/internal/build-targets.ts`) because a composition created in
Studio lives only in a user layer and must still be servable. Both call sites say
so.

### One invocation, N targets

The deploy posture mirrors `hermetic-build.ts`: **a shared prefix once, then a
loop over targets.**

```
per invocation:  preflight → resolve targets → lock → stage 1 (deps + every
                 target's registry) → stage 2 (migrations + codegen) → format →
                 validation → central → ONE verdict
per target:      marker → build+publish dist → DB → propagate config → spec →
                 restart → health probe → receipt
```

The loop does NOT live inside `build.ts`'s terminal funnel — that closure already
holds eleven invocation-scoped values, and fanning out inside it is how the file
reached 1900 lines. `plugins/build/cli/internal/build-targets.ts` decides what a
target IS (id → manifest row → namespace → collision guard);
`plugins/build/cli/internal/deploy-namespace.ts` deploys one, returning a
discriminated result and never calling `process.exit`. `build.ts` keeps the
funnel, the guard, the receipts, the recorder and the verdict.

What is per-invocation and what is per-target is not a matter of taste — six
module globals decide it. `openBuildProgress` (one `current`; a second call is a
silent no-op), the op profiler, the worktree-op marker, `installVerdictGuard`
(one `emittedVerdict`, exactly one verdict per process), `installFatalSignalExit`
(armed once, before the loop, because Bun installs its `sigaction` lazily on the
first `process.on(sig)` and does not chain), the build profile and step log, and
the **single `build_runs` row** are all keyed on the CHECKOUT's own namespace.
The deploy receipt is the one that is genuinely per-namespace — it is the file
the gateway-facing deploy answers for — so it is a `Map`, and a target that
publishes closes its own entry immediately, so a later failure can never rewrite
it as `failed`.

Three orderings that look incidental and are not:

- **Every target's `sweepDistLeftovers` runs up front**, before any staging dir
  exists. Sweeping inside the loop deletes target 2's staging dir while target
  1's is live.
- **The `composition.json` marker is written TWICE** for a composition target,
  and both are load-bearing. FIRST, before anything else touches the namespace
  dir — a crash mid-build otherwise leaves a marker-less dir the collision guard
  refuses forever. AGAIN in the same breath as `spec.json`, because the claim
  alone does not survive: a build spends most of its wall time parked on the host
  CPU grant, and one namespace dir was removed underneath a waiting build
  (2026-08-19), which recreated every other artifact at the end and came up live
  with no marker — unre-servable, unresettable, reported as not served. The write
  (`stampCompositionMarker`, `infra/worktree`) is atomic, idempotent and reads
  itself back, so the second call is a no-op when nothing went wrong and the
  build fails loudly rather than publishing a spec for a namespace with no
  provenance. The checkout's own app writes no marker at all: that namespace
  belongs to the checkout, and a marker there would make the next same-named
  worktree refuse to be created.
- **The database is two opposite operations, not one function with a flag.** The
  checkout's own app runs on the worktree FORK (which carries main's data —
  creating it empty would be wrong), every other composition gets an EMPTY
  database the backend's boot migrator fills. The fork wait is hoisted into the
  invocation prefix because the ledger row lives in that database.

The backend's durable build lock — the `build_runs_inflight_uniq` partial unique
index the claiming INSERT contends on — is deliberately target-blind, so a live
composition build makes the UI drop a main auto-build request in the same
checkout. Correct: the per-checkout `.build.lock` serializes them anyway.

The ordered pipeline both postures drive is
[`plugins/build/cli/internal/app-artifacts.ts`](plugins/build/cli/internal/app-artifacts.ts)
— read its docblock before touching either posture. It owns the three stages
(`prepareCompositionSources` → `generateAppSources` → `buildAndPublishWebDist`),
`fastValidationJobs` and `acquireArtifactLock`, plus the
explicit list of what stays *out* (cluster readiness, the run ledger, gateway
HTTP, worktree-op markers, the provenance marker, `propagateConfigToUser`). It is split
into three functions rather than one because `build`'s dev-only steps interleave
*between* them. Same shape, one level up, as codegen's `regen-pipeline.ts`.

Two consequences worth knowing before editing:

- **Every filtered registry is per-composition**
  (`<dir>.composition.<id>.generated.ts`) and `plugins-active.ts` selects one
  only under a matching `composition` — the field the backend reads back off its
  own `~/.singularity/worktrees/<namespace>/spec.json`, the same file the gateway
  read to spawn it (`plugins/framework/plugins/server-core/bin/spec-composition.ts`; deliberately not an env var,
  because `build` does not rebuild the Go gateway and a dropped variable would
  boot the full app under a composition's namespace) — so a file on disk cannot
  reconfigure a backend that was not told to load it, and a missing one throws
  rather than quietly booting the full app. A plain `build` names the MAIN
  composition, which emits no filtered file at all, because its registry IS the
  committed `<dir>.generated.ts` — so stage 1 skips the plugin-tree walk entirely
  for it.

  **Filtered registries are never swept.** They used to be, by the compose-serve
  deactivation stage; with that stage deleted they accumulate in every checkout
  that has ever served something. Gitignored, but they are `tsc` input. Phase 5
  of `research/2026-08-17-global-composition-build-serve-model.md` owns the
  reclaim trigger.
- **No CLI process may load a registered pre-barrel or post-web codegen
  manifest that it later regenerates.** Bun freezes a module on first
  `import()`, and stage 2 regenerates every such manifest and then re-reads it: a
  manifest the process already loaded is rewritten on disk but never re-read, so
  `generateConfigOrigins` sees the previous run's descriptor set and
  `pruneOrphanedConfigFiles` deletes a freshly-authored config override — silent
  data loss, no failing step. Enforced by `cli:codegen-manifests-not-frozen` as
  two rules. The **startup closure** (`bin/index.ts` → `bin/cli.ts` → every
  command *declaration*) may load no manifest. The **run closure of each command
  that regenerates in-process** may load none either. Each `run: () => import(…)`
  thunk is cut out of startup, because one process runs one command's body.
  "Regenerates" is derived, not listed: live code in that closure calls the
  registry's writer (`writePreBarrelManifest`) — today `build`,
  `regen-generated` and, conservatively, `check`. So `deploy converge` may load
  `fieldsEager` through an entity-backed handle; `build`'s body may not. Process
  isolation is the correctness boundary: `release` needs stage 2 but **shells
  out** to a fresh `build --hermetic` (its own body statically imports plugin
  barrels), and `push` / `normalize-generated` spawn `regen-generated` — never
  "simplify" those into in-process calls.

Design + rationale:
[`research/2026-07-28-cli-hermetic-artifact-phase.md`](../../../../research/2026-07-28-cli-hermetic-artifact-phase.md),
then [`research/2026-08-18-cli-one-build-verb-artifact-half.md`](../../../../research/2026-08-18-cli-one-build-verb-artifact-half.md)
for the fold back into one verb.

### A build names WHICH dist it produces; it never spells a path

`buildAndPublishWebDist` takes a `WebDistTarget` — `{kind:"served",name}` or
`{kind:"release",worktree,composition}` — and `webDistPath()` is the one mapping
from identity to directory (callers resolve their own `sweepDistLeftovers`
through it too). Two consequences that look wrong and are not:

- **`webDir` is for `.build.lock` only.** The lock is per-checkout because it
  guards registry codegen written *into* the checkout — unrelated to where the
  dist lands. Don't re-derive `livePath` from it.
- **The building worktree's name is `checkoutWorktreeName(root)`, never
  `runtimeNamespace()`** — a CLI process declares no runtime namespace at all
  (only a gateway-spawned backend does), so asking for one throws.
  `release` spawns `build --hermetic` with `cwd` at that root, so both resolve
  the same dist by construction.

**No dist lives in a checkout.** Both arms resolve under
`~/.singularity/worktrees/` — served at `<name>/web`, release scratch at
`<wt>/release-web/<id>` — so a checkout carries no build output. The backend-side
twin is `webDistDir()` (`infra/paths`), which is per-NAMESPACE and must stay a
function, not a const. The pre-S4 in-checkout tree is reclaimed by
`internal/legacy-dist-reap.ts`, gated on the **running gateway** reporting the
new path (`GET /gateway/worktrees`), never on `spec.json` — the gateway serves
from its own in-memory spec, so disk is no evidence about what is being served,
and that gate was observed deleting a live tree. Every other answer (unreachable,
unregistered, malformed) fails closed, which also keeps a `--hermetic` build
hermetic: a bare release host has no gateway and no served legacy dist either.
[`research/2026-08-06-global-one-dist-per-namespace.md`](../../../../research/2026-08-06-global-one-dist-per-namespace.md).

### The experimental frame is stamped by the producer

The red agent-worktree border is stamped into the staged `index.html` by
`buildAndPublishWebDist`'s `experimental` flag
([`plugins/build/cli/internal/experimental-marker.ts`](plugins/build/cli/internal/experimental-marker.ts)),
never inferred in the browser: `<name>.localhost` is equally the grammar for
worktree deploys, composition namespaces and release previews, so no client-side
rule can tell them apart. Only `build` from a non-main CHECKOUT passes `true` —
a fact about the checkout, not about the composition, so every namespace a
worktree publishes carries the frame and main's publishes none. Every other dist
producer is clean by default, not by exclusion. CSS rule in
ui-kit's `theme/app.css` (JS-sets / CSS-styles split, as with `.dark`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The `./singularity` CLI: the command declaration contract, the generated-artifact normalize contract, and every built-in command (build, push, check, test, run, release, deploy, and more).
- Core:
  - Uses: `framework/tooling/collected-dir.defineCollectedDir`
  - Exports (types):
    - `ClaudeMdRepo`
    - `CliAction`
    - `CliArgumentSpec`
    - `CliCommand`
    - `CliCommandSpec`
    - `CliOptionSpec`
    - `MergeMarkerKind`
  - Exports (values):
    - `clearMergeMarkers`
    - `cliEntrySourcePath`
    - `defineCliCommand`
    - `findClaudeMdConflicts`
    - `isCliCommand`
    - `isCliEntryPresent`
    - `MERGE_MARKER_KINDS`
    - `mergeMarkerDir`
    - `readMergeMarkers`
    - `resolveGitDir`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: `framework/tooling/import-closure`
- Sub-plugins:
  - **`await`** — `./singularity await` — block until this checkout's running op writes its verdict, and print it. Starts nothing; the wake-up becomes a tool result instead of a notification that may never arrive.
  - **`bootstrap`** [exempt] — CLI bootstrap — the npm-free half that must run with node_modules absent: ensureDeps, the post-install re-exec, the orphan guard, the build lock.
  - **`build`** — `./singularity build` — the deploy command: codegen, migrations, web dist and backend restart for this checkout, or a composition's hermetic artifact set.
  - **`check`** [exempt] — `./singularity check` — run the repo validation checks (all, a named subset, or one scope). The only in-process caller of runChecks(): `build` and `push` each spawn it as a subprocess, so their…
  - **`db`** — `./singularity db` — worktree database operations; today just `db fork`, which gives a hand-made `git worktree add` checkout the DB fork it never got.
  - **`deploy`** — `./singularity deploy converge|ship` — converge a host to serve a composition (run user, dirs, env, Caddy, systemd, firewall) and ship release bundles to it behind a health gate.
  - **`doctor`** — The prerequisite doctor: doctor.sh names every missing prerequisite (Xcode CLT/git, mise active, the locked toolchain) in one run, with its fix, and advises on Claude Code (installed and signed in)…
  - **`format`** — `./singularity format` — prettier over the .ts/.tsx changed on this branch; the same pass `build` runs, without paying for a build.
  - **`git-artifacts`** — Generated-artifact merge handling that runs inside a CLI command: re-deriving after a merge driver took the cheap side, and installing the drivers.
  - **`migrations`** [exempt] — Drizzle migration generation for the CLI: the generate/rename/journal pipeline and the interactive drizzle-kit prompt driver.
  - **`normalize-generated`** — `./singularity normalize-generated` — re-derive the generated artifacts a merge driver auto-resolved during a merge or rebase and amend the head commit; the `post-rewrite` git hook's entry point.
  - **`op-runtime`** [exempt] — Shared machinery of the op commands (build / check / test / push / run <e2e>): broadcasts, deploy receipt, fatal-signal exits, lane, op profiler, progress log, admission valve, nested check, build…
  - **`push`** — `./singularity push` — the one path work reaches main: commit, rebase onto main, re-normalize generated artifacts, run the tree-scoped checks, fast-forward and push, all under the host-wide push…
  - **`regen-generated`** — `./singularity regen-generated` — the repo-tree half of build's codegen standalone (registries, barrels, plugin docs, manifests, config origins), for the post-rebase normalize step in `push`.
  - **`regen-migrations`** — `./singularity regen-migrations` — discard branch-local migrations and re-generate them against the rebased schema, for the post-rebase normalize step in `push`; aborts on hand-edited SQL.
  - **`release`** — `./singularity release` — stage a composition into a portable, self-contained artifact (compiled binaries + vendored native PG/PgBouncer/gateway/parcel-watcher) and pack it as a single-file web…
  - **`run`** — `./singularity run <script.ts> [args…]` — run a repo script against THIS worktree's own dependencies; the correct spelling of `bun <file>`, which silently resolves another checkout's installed tree.
  - **`serve-app`** [exempt] — `./singularity serve-app` — boot a packaged app's full runtime (gateway + embedded Postgres + app DB) under an isolated SINGULARITY_DIR. The one detachable command: it is meant to outlive the shell…
  - **`start`** — `./singularity start` — build the gateway and register it as a launchd service (macOS) so it comes back after a reboot, then wait for it to actually serve before reporting success.
  - **`stop`** — `./singularity stop` — stop the gateway daemon (and with it every backend); `--disable` also stops it starting at login.
  - **`test`** — `./singularity test` — the ONLY way to run tests: both runners (bun:test for co-located logic suites, vitest for jsdom suites), with a summary naming both buckets so a green-but-partial result is…
  - **`upstream`** — `./singularity upstream status|merge` — what the repo this checkout was cloned from has that local main does not, and the one sanctioned merge that brings it into a worktree branch.

<!-- AUTOGENERATED:END -->
