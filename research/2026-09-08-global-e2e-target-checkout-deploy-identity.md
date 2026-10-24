# e2e target: resolve the deploy from the registry on disk, then prove the build answering it

## Context

An e2e script run from a worktree with no `--url` silently drives **main's** deploy
(`http://singularity.localhost:9000`) and reports `ALL CHECKS PASSED`. It can also invent
failures about code that is not under test — which is how it surfaced, after several rebuild
cycles spent investigating a defect that did not exist.

It is not only a wrong verdict. `withBrowser`'s first statement is
`repairAgentConfigWrites("start")`, which POSTs through `agentFetch` to the **resolved origin**
— so every browser script run from a worktree agent session reverts the user's live config
documents on main before doing anything else. And one script already deletes a file there: see
"the live sibling" below.

The cause is one expression in `e2e/target.ts`'s `rawTarget()`:

```ts
const name = asNamespace(
  process.env.SINGULARITY_WORKTREE ?? checkoutWorktreeName(REPO_ROOT),
);
```

`SINGULARITY_WORKTREE` is not a *wrong* answer — it answers a **different question about a
different process**: "which namespace is this *backend* the server for" (`gateway/worktree.go`
sets it on every backend it spawns). An agent pane is spawned by main's backend and inherits it
through the tmux server's environment, so it is *always* present and *always* names main.
Measured in this session: `SINGULARITY_WORKTREE=singularity`, `SOCKET_PATH=…/singularity.sock`,
cwd `.claude/worktrees/att-1788856801-y7ze`.

**Why this is a deletion, not a disagreement rule.** A "refuse when the two disagree" design
would abort *every* agent-session e2e run, because in an agent session they always disagree —
and it would misdescribe the world, since the env var is not making a claim about this checkout
at all. The repo already encodes the right instinct one level up: `tmux-runtime.ts:668-670`
**renames** the backend's `SINGULARITY_WORKTREE` to `SINGULARITY_PARENT_HOST` when it crosses
into a child, precisely because its meaning changed. The genuine contradiction lives one level
*down* — the namespace we computed vs. the build actually answering it — and that is where a
loud assert belongs.

**Intended outcome.** An argument-less e2e run either drives the deploy **this checkout
published** and says so on its first line, or refuses with an actionable message. It can no
longer go green against somebody else's app.

## Root cause

Two independent errors in `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/target.ts`:

1. **Wrong input.** The env read was never in the design —
   `research/2026-07-23-global-e2e-per-plugin-tests.md` specifies
   `--base|--url|--origin → $SINGULARITY_E2E_BASE → basename(REPO_ROOT)` with no env term, and
   `git log -S` puts the read in the file's first version (`49931f773`) with no rationale, in the
   same commit whose docblock argues the default must be *derived from the checkout*. The prose
   says checkout; the code put the env first. No caller has ever needed it.

2. **Laundered brand.** `checkoutWorktreeName` returns a plain `string` *deliberately*
   (`plugins/infra/plugins/paths/core/internal/paths.ts`: "A checkout name is one INPUT to a
   namespace, not a namespace… Mint the namespace with `namespaceFor`"). `asNamespace` is
   documented as a validating cast *at a serialization boundary*; using it here defeats the
   rung-2 guard the `Namespace` brand exists to provide.

**The deeper problem: the answer is guessed from a name when it was recorded at mint time.**
`namespaceFor`'s own docblock states the rule — provenance on disk cannot be ambiguous, a name
can. Every deploy writes `~/.singularity/worktrees/<ns>/spec.json` whose `server` field is the
absolute path of the checkout that published it (`build/cli/internal/deploy-namespace.ts`).
Verified on this machine:

```
singularity           → server: <main>/plugins/framework/plugins/server-core, composition "singularity"
att-1788855936-l4oz   → server: <that worktree>/plugins/framework/plugins/server-core
central               → server: <main>/plugins/framework/plugins/central-core   (an exact match excludes it for free)
att-1788856801-y7ze   → no entry at all — this checkout has never been built
```

That last line is the truth the current code replaces with main's URL.

**The live sibling — same expression, and it deletes a real file.**
`plugins/apps/plugins/mail/plugins/threads/e2e/mailbox-tabs-verify.ts:74-75` carries
`process.env.SINGULARITY_WORKTREE ?? basename(REPO_ROOT)` and feeds it to two `rmSync(USER_OVERRIDE)`
calls (lines 185, 362). From a worktree that resolves to
`~/.singularity/config/singularity/apps/mail/threads/mail-threads.jsonc` — verified present —
the user's live Mail config on main. Its docblock states the correct rule immediately above the
code that breaks it, which is the proof that documentation (rung 5) does not hold this class.

## The model

Three questions, three answers, permanently distinct:

| question | answer | who may ask |
|---|---|---|
| which namespace is **this backend** the server for? | `SINGULARITY_WORKTREE` → `currentWorktreeName()` | a gateway-spawned backend, only |
| which namespace does **this checkout** own? | `checkoutNamespace(root)` (git-minted) | CLI, checks |
| which deploy did this checkout **publish**? | `resolveCheckoutDeploy(root)` (read from `spec.json`) | the e2e harness |

The harness asks the third and proves the answer. After this change **no environment variable
has any spelling in the `e2e` runtime** — nothing left to prefer, contradict, or get wrong.

## Design

### 1. The deploy registry becomes a readable API (`paths/core`)

New `plugins/infra/plugins/paths/core/internal/checkout-deploys.ts` — sync, git-free, env-free:

```ts
export interface CheckoutDeploy {
  readonly namespace: Namespace;
  /** Absent `spec.composition` means the main app (the legacy shape). */
  readonly composition: string;
  readonly isMainComposition: boolean;
}
export type CheckoutDeployResolution =
  | { kind: "resolved"; deploy: CheckoutDeploy }
  /** `others` = what this checkout DOES serve, for the message. */
  | { kind: "none"; others: readonly CheckoutDeploy[] };

export function deploysForCheckout(root: string): CheckoutDeploy[];
export function resolveCheckoutDeploy(root: string, composition?: string): CheckoutDeployResolution;
```

Scan `listWorktreeDirs()` → filter with **`isNamespace`** (never `asNamespace`, which throws — one
stray directory name would break every e2e run on the machine) → read `worktreeArtifacts.spec(ns)`
→ keep when the spec's `server` equals `<root>/plugins/framework/plugins/server-core`. Order the
main composition first. ~73 directories, one small sync read each.

Two rules the naive version gets wrong, both load-bearing:

- **Missing ≠ malformed.** `ENOENT` on `spec.json` is an unconditional skip: 6 of the 73
  directories have no spec today (`head-check`, `reorder-land-…`, four `att-*`). Only a
  **present-but-unparseable** spec is malformed.
- **Decide after the whole scan, not during it.** Collect malformed entries, then: warn (stderr,
  naming the paths) if the completed scan found a match; throw only if it found none. Deciding
  mid-scan makes the outcome depend on `readdir` order for identical on-disk state.

Compare both sides through `realpathSync`: the writer resolves against `getWorktreeRoot()` (git
toplevel) while the reader resolves against `REPO_ROOT` (`import.meta`-derived). They agree today
but diverge under a symlinked checkout, and the failure mode is fleet-wide — every run in that
checkout refuses with `registered : (none)`, which reads as "you never built" and points at the
wrong fix. On the `none` arm, also list specs whose `server` named a *different* checkout, so a
path mismatch is distinguishable from "never built".

Supporting moves (pure relocation, all existing importers untouched):

- `listWorktreeDirs`: `paths/server/internal/worktree-dirs.ts` → `paths/core/internal/`, keeping
  the `paths/server` re-export (its four importers all use the server barrel).
- `SERVER_CORE_RELATIVE = "plugins/framework/plugins/server-core"` added to
  `paths/core/internal/paths.ts` **and to `paths/core/index.ts`'s export list** — note
  `WEB_CORE_RELATIVE` beside it is *not* exported from the core barrel today, so there is no
  existing neighbour to copy. Replace the two inline copies of the literal
  (`build/cli/internal/deploy-namespace.ts`, `cli/plugins/serve-app/cli/run.ts`) so writer and
  reader share one spelling and cannot drift into a silent "no deploy".

### 2. The build receipt becomes readable outside the CLI

`op-runtime/cli/build-receipt.ts` is already core-clean (`node:fs` + paths + a `Namespace` type).
Move it to a new `plugins/framework/plugins/cli/plugins/op-runtime/core/` barrel (swapping its
`paths/server` import to `/core`), leaving `cli/build-receipt.ts` as
`export * from "../core/internal/build-receipt";` so all 16 importers are untouched.

### 3. `target.ts` reads the registry

The type carries provenance, so the identity assert is **unwritable** for a caller-stated URL:

```ts
type Target =
  | { kind: "derived"; origin: string; deploy: CheckoutDeploy; page?: string }
  | { kind: "stated";  origin: string; flag: string;            page?: string };
```

- Deleted: `process.env.SINGULARITY_WORKTREE`, the `asNamespace` import, the
  `checkoutWorktreeName` import — **and `$SINGULARITY_E2E_BASE`**. Nothing in the repo sets that
  var; it is read only here. It is the same shape as the defect being fixed (an inherited channel
  that silently wins) and it is strictly more dangerous, because it produces the `stated` arm,
  which the new assert deliberately skips. One `export` in a shell profile would reinstate the
  entire bug with the new proof disarmed. `--url` covers every operator case and is
  per-invocation.
- Kept: `--url` / `--base` / `--origin`, and `namespaceUrl` as the only URL spelling.
- New `--composition <id>`: the only way to name `sonata.att-x`, and the reason a
  composition-only build stops being a silent wrong answer. **`--composition` alongside any
  stated-target flag is a `usage()` error** — the same discipline the file already applies to
  `--url`-with-path plus `--path`. A deploy selector the run silently drops is worse than a page
  it drops.
- New export `targetNamespace(): Namespace`, for a script that must name a per-namespace file on
  disk. Derived arm: the resolved deploy. Stated arm: `namespaceFromHost(url.host)`, refusing a
  non-namespace host. The barrel's "no origin is exported" comment gains: *a namespace is an
  identity, not an origin — rebuilding one from it with `namespaceUrl` ignores `--url`.*
- **Print the target inside `target()`'s memoized first resolution**, so all 165 scripts name
  their deploy, including the ones that never bind `pathUrl` at module top level. Today 134 of
  165 print nothing identifying the deploy, which is why this was invisible in transcripts.

```
target: http://att-1788856801-y7ze.localhost:9000  (this checkout's singularity deploy, build-1788862071773-kb3y1y, built 4m ago)
```

Rewrite the file header: its "in every worktree, forever" guarantee becomes true for the first
time.

### 4. `deploy-identity.ts` — prove the build, don't compute it

New `e2e/deploy-identity.ts` exporting a memoized `assertDeployIdentity(): Promise<void>`.

It **must force target resolution first** — sited as `withBrowser`'s first statement it would
otherwise read an unresolved target and silently no-op for the ~134 scripts that don't bind
`pathUrl` at module top level.

1. `kind === "stated"` ⇒ return. A `--url` may legitimately name a staged release bundle on its
   own port (`release/e2e/release-boot-verify.ts`).
2. `resolveBuildReceipt(deploy.namespace)` from the new `op-runtime/core`.
3. Probe: `fetch(pathUrl("/.build-id"))`, read at most 128 bytes, `trim()`, **exact string
   compare** against `receipt.buildId`.

The verdict depends on what the receipt claims, and **only an `ok` receipt can throw**:

| receipt | meaning | action |
|---|---|---|
| `ok` | this checkout published `buildId` | mismatch ⇒ **throw** (stale or foreign deploy) |
| `running` | a build is mid-flight; the dist swaps only at the very end | probe, **warn**, proceed |
| `interrupted` | a build died without a verdict | probe, **warn**, proceed |
| `failed` / `superseded` | the origin is knowably serving an earlier build of this checkout | **warn** naming both ids, no probe |
| `none` | a spec but no receipt | **warn** |

The earlier draft threw on `running` and `interrupted`; both were wrong. Main auto-builds on every
`refs/heads/main` advance, so `running` would be a new ~10-minute hard-refusal window on the
deploy an agent working on main is most likely driving — and for most of that window the served
dist is still the previous, complete, correct build. `interrupted` is worse: root CLAUDE.md
documents it as routine ("a build killed by a caller timeout … leaves `status: running` with a
dead pid"), and nothing rewrites the receipt until the *next* build — so one timed-out build
would block all 165 scripts in that checkout indefinitely. In both cases the namespace resolution
has *already* excluded the wrong-app class this change exists to kill. Reuse
`interruptedPredecessorWarning` (`op-runtime/cli/build-receipt.ts:139-152`) for the wording rather
than inventing a second one.

Warning rather than throwing also keeps `repairAgentConfigWrites("start")` reachable — the half
`browser.ts` calls "the half no teardown can provide".

Two traps the compare must survive, both verified live:

- A **miss falls through to the SPA**: `GET /.no-such-file` → `200 text/html 265869B`. `res.ok` is
  not evidence; an exact compare against a `build-<ms>-<rand>` id is.
- Do **not** read the local `.build-id` from `worktreeArtifacts.webDist(ns)`. `spec.web` *is* that
  directory, so an fs read there and the HTTP GET resolve to the same file and the comparison is a
  tautology. The two sides must be independently written records: `build-status.json` at the
  namespace dir root vs `.build-id` inside the published dist.

Verified live: `GET /.build-id` → `200 text/plain 27B build-1788862071773-kb3y1y`, byte-identical
to the receipt.

**Wiring — both entry points:**

- `browser.ts`: the new **first statement of `withBrowser`, above `repairAgentConfigWrites("start")`**.
  That ordering is the highest-value half of the fix: today that POST goes to the resolved origin
  before anything else happens. Record why in a comment.
- `app-fetch.ts`: awaited inside `agentFetch`. It already returns `Promise<Response>`, so no caller
  signature moves. This covers `plugins/reports/e2e/fan-out-ceiling.ts`, the only standalone
  deploy-touching script that never launches a browser.

One lint exemption with a stated reason in `agent-origin-safety/lint/index.ts`'s
`ignores["no-unmarked-app-fetch"]`: the probe is a `GET` of a gateway-served static file that
writes nothing, and it *gates* `agentFetch`, so routing it through `agentFetch` would deadlock on
the memo.

**Known limit, to be stated in the docblock and CLAUDE.md:** the assert covers the served *dist*,
not the backend. `./equin build --no-restart` returns `ok` with a new dist and the previous
backend, so a run can still be green against a new frontend talking to old server code.

### 5. The class cannot come back

- **Check `e2e-harness:target-not-env-derived`** (new file beside `browser-through-harness.ts`,
  registered in that plugin's `check/index.ts`): `grepCode` for `process\.env\.SINGULARITY_` over
  pathspec `["*/e2e/*.ts"]`, with `target.ts` allowlisted by path — the same shape
  `browser-through-harness.ts` already uses to exclude `browser.ts`. Grepping the one literal
  `SINGULARITY_WORKTREE` would not see a second env-shaped target being introduced. It earns a
  real hit on day one (`mailbox-tabs-verify.ts`), which is what makes it a check rather than a
  convention.

  Hint: *An e2e script's process inherits `SINGULARITY_WORKTREE` from the backend that spawned its
  agent session — in a worktree it answers `singularity`, so reading it silently drives and writes
  to MAIN's deploy. Use `pathUrl(path)` for a URL, `targetNamespace()` for the namespace whose
  files you assert on, `--composition <id>` for a composition, `--url` for a deploy this checkout
  did not build.*

- **Lint rule `namespace-identity/no-laundered-checkout-namespace`** (new lint plugin): bans
  `asNamespace(checkoutWorktreeName(…))` and `asNamespace(basename(…))` repo-wide. It **must** be
  listed in `enforceEverywhere`, or `NON_APP_FILE_GLOBS` silently disables it in exactly the e2e
  and test files where two of the known instances live. (Contributed rule files *may* import
  `@plugins/*` — several do — but spelling the identifiers literally is still right for an AST
  rule.)

### Exact failure messages

**No deploy at all** (`usage()`, stderr, exit 2):

```
No deploy for this checkout — there is nothing to run against.

  checkout   : /Users/…/.claude/worktrees/att-1788856801-y7ze
  registered : (none)

Nothing under /Users/epot/.singularity/worktrees is registered to this
checkout's backend, so `./equin build` has never published a deploy from
here. Run it, then re-run this script.
To drive a deploy this checkout did not build, name it:
  --url http://<namespace>.localhost:9000
```

**Composition-only build** — the case a basename gets silently wrong:

```
No deploy for this checkout's own app (composition "singularity").

  checkout   : /Users/…/.claude/worktrees/att-1788856801-y7ze
  registered : sonata.att-1788856801-y7ze (composition "sonata")

A `--composition` build publishes only that composition's namespace, never the
checkout's own app. Run `./equin build` here to deploy it, or target one
of the deploys above with --composition sonata.
```

**Unknown `--composition x`**: same shape, listing the registered compositions.

**Wrong deploy** (throw, `ok` receipt only):

```
The deploy answering this target is not the build this checkout published.

  target  : http://att-1788856801-y7ze.localhost:9000
  built   : build-1788862071773-kb3y1y  (commit 01cb3f12f)
            recorded in ~/.singularity/worktrees/att-…/build-status.json
  serving : build-1788858134087-2vhb2l

Every assertion below would be made against code this checkout did not
produce, and every write would land on it.
Run `./equin build` here, then re-run this script.
```

When the probe falls through to the SPA, `serving` reads
`<no .build-id at this origin — the request fell through to index.html>`.

**Unreachable** (throw): names the namespace, the probe URL, and the transport result, and says
the receipt claims it landed, so the gateway or backend is not serving it.

**Warnings** (`running` / `interrupted` / `failed` / `superseded` / `none`): one stderr line
naming which build the receipt describes and which build is answering, so the discrepancy is on
screen without refusing a run that is probably sound.

**`targetNamespace()` on a non-namespace `--url` host** (`usage()`): explains there is no
per-namespace directory to read, and to point at a gateway deploy or drop the flag.

## Steps

1. **Relocate `listWorktreeDirs` into `paths/core`** — `paths/core/internal/worktree-dirs.ts`,
   `paths/core/index.ts`, `paths/server/index.ts`. Its only import (`worktreesDir`) becomes
   `./paths`; keep the server re-export; move the co-located test.
2. **Add `SERVER_CORE_RELATIVE` and make the writer share it** —
   `paths/core/internal/paths.ts` + **`paths/core/index.ts`** (a new export line, not a copy of a
   neighbour), then replace the inline literal in `build/cli/internal/deploy-namespace.ts` and
   `cli/plugins/serve-app/cli/run.ts`.
3. **Add the deploy-registry reader** — `paths/core/internal/checkout-deploys.ts` +
   co-located test, exported from `paths/core/index.ts`. Implements the missing-vs-malformed
   split, the after-the-scan decision, and `realpathSync` on both sides.
4. **(Separable) Relocate `checkoutRef` and name the mint** — move
   `paths/server/internal/checkout-ref.ts` → `paths/core/internal/`, keep the `paths/server`
   re-export (8 importers, three of them `server/` files), and add
   `checkoutNamespace(root) = namespaceFor(MAIN_COMPOSITION_ID, await checkoutRef(root))`,
   collapsing the hand-spelled mints in `build/cli/run.ts`, `hermetic-build.ts`,
   `check/cli/run.ts`, `push/cli/run.ts`, `prototypes/…/cli/prototype-url.ts`. Note
   `build/cli/run.ts:540` already binds `checkoutRef` for `resolveBuildTargets` — call
   `checkoutNamespace` alongside it rather than trying to collapse that binding away.
   *The e2e fix does not need this step* (the registry scan is sync and git-free); it is here
   because five copies of one derivation is the structural defect underneath this bug, and the
   `./equin test` follow-up needs the helper.
5. **Give the build receipt a core barrel** — `op-runtime/core/{index.ts,internal/build-receipt.ts}`,
   with `cli/build-receipt.ts` reduced to a re-export. Move the co-located test.
6. **Rewrite the e2e target against the registry** — `e2e/target.ts`: the `derived | stated`
   union, `resolveCheckoutDeploy`, the deletions (env var ×2, `asNamespace`,
   `checkoutWorktreeName`), `--composition` (+ its conflict refusal), `targetNamespace()`, the
   one-line print, the rewritten header.
7. **Add the runtime identity assert** — `e2e/deploy-identity.ts`, per the receipt table above.
8. **Wire it into both entry points** — `browser.ts` (first statement of `withBrowser`, above the
   config repair, with the comment), `app-fetch.ts` (inside `agentFetch`), `e2e/index.ts` exports.
9. **Exempt the probe from `no-unmarked-app-fetch`** — `agent-origin-safety/lint/index.ts`, with
   the reason. Without this, `./equin check` fails on the new file.
10. **Add the rung-3 backstops** — the `e2e-harness:target-not-env-derived` check (update that
    barrel's docblock from two checks to three) and the `namespace-identity` lint plugin with a
    co-located `RuleTester` suite.
11. **Fix the two live instances the new rules catch** —
    `mailbox-tabs-verify.ts`: `configDir.file(targetNamespace(), STORE_PATH)`, drop the
    `REPO_ROOT`/`basename` imports, correct the docblock.
    `web-artifacts/check/index.ts`: replace `asNamespace(checkoutWorktreeName(root))` with the
    namespace from `resolveCheckoutDeploy(root)` — this touches **all three** `distDir(root)` call
    sites, not one: `mapInSync.cacheSignature()` returns null on `none`, `mapInSync.run()` reports
    "never been built" without a path, and `noVendoredStateInlined.run()` defaults `minify` to
    true on `none`. Stays synchronous, so `cacheSignature` is unaffected.
12. **Docs and regeneration** — `e2e-harness/CLAUDE.md` (registry-derived default,
    `--composition`, `targetNamespace()`, refusal shapes, and the assert as the third
    "green without exercising the app" mechanism, including its dist-not-backend limit);
    `paths/core/internal/paths.ts` — **two** docblocks, `checkoutWorktreeName`'s *and*
    `webDistDir`'s at :492, which currently instructs the reader to build a namespace out of a
    checkout basename and would be the only surviving instruction to do so; root `CLAUDE.md` —
    replace the raw `bun run playwright screenshot … http://<worktree>.localhost:9000` snippet
    under "Driving the app" with `./equin run …/e2e/screenshot.ts [--path /agents]`, since
    that `<worktree>` placeholder is hand-substituted by the same agent whose shell says
    `singularity` — the identical wrong answer, arrived at by hand, and the one path none of the
    new rungs reach. Then `./equin build` to regenerate `check.generated.ts`,
    `lint.generated.ts` and the plugin docs.

## Fix ladder

- **Rung 1 (inexpressible)** — no environment variable has any spelling in the `e2e` runtime; the
  target comes from the registry, so there is no second input to prefer or contradict.
- **Rung 1** — `SERVER_CORE_RELATIVE` spelled once, shared by writer and reader, so the
  checkout→namespace back-pointer cannot drift into a silent "no deploy".
- **Rung 1** — `checkoutNamespace(root)` names the mint currently hand-spelled five times.
- **Rung 2 (tsc)** — the `derived | stated` union puts the deploy identity only on the derived arm,
  so "assert identity against a caller-supplied `--url`" has no spelling; and with the launderings
  gone, the `Namespace` brand does the job it was introduced for.
- **Rung 3** — `namespace-identity/no-laundered-checkout-namespace` (lint, repo-wide) and
  `e2e-harness:target-not-env-derived` (check, `*/e2e/*.ts`).
- **Rung 4 (loud runtime)** — `resolveCheckoutDeploy`'s `none` arm via `usage()` (exit 2, before
  anything runs); `assertDeployIdentity()`'s throw, before chromium launches and before the
  config-revert POST.
- **Rung 5** — the `target.ts` header, `e2e-harness/CLAUDE.md`, and the one-line target print.
  Additive only, never the fix.

## Out of scope — same root cause, separate changes

Ranked by severity. Each is "a process that is not a gateway-spawned backend read
`SINGULARITY_WORKTREE`", verified during this investigation.

1. **`./equin deploy` from a worktree acts on MAIN.** `deploy/cli/internal/target.ts` uses
   `currentWorktreeName()` for both the server pool and the backend base, so it reads main's
   `deploy_servers` rows and TOFU-pinned SSH private key, POSTs `createDeployment` to main's
   backend, and SSHes a **real remote host**. Its own docblock claims it "acts on exactly the
   namespace whose Deploy app you are looking at" — false in a worktree.
2. **`./equin test` from a worktree runs DB suites against MAIN's Postgres.**
   `test/cli/run.ts` spawns bun via `spawnPassthrough(argv, {cwd: root})` with no `env`;
   `test/bun-preload.ts` fills the var only when *unset* (in a pane it is set-and-wrong);
   `database/server/internal/client.ts`'s `requireWorktree()` uses it directly as the database
   name. Two `tasks-core` suites reach `worktreeDbScenario`, whose `installQueueSchema` runs real
   `graphile_worker` DDL there **outside any transaction**. The fix is small — pass
   `-e SINGULARITY_WORKTREE=<the pane checkout's namespace>` on `tmux new-session` in
   `runtime-tmux/server/internal/tmux-runtime.ts`, which already passes two other vars that way,
   plus a belt at the test spawn — but it flips every agent pane's database, config dir, log dir
   and `isMain()` at once and creates a flag day for in-flight sessions. It needs its own
   verification pass, and it needs `checkoutNamespace(root)` from step 4, so this lands first.
   `SOCKET_PATH` leaks by the identical tmux-global mechanism and should ride with it.
3. **`./equin apply-migrations` by hand from a worktree** applies pending migrations to
   main's database and prints success naming `singularity`.
4. **`config_v2`'s `CONFIG_DIR`, `log-channels`' durable sink, and `reports`' row tag / buffer
   path** all resolve from the env at module eval, so any CLI or test process in a worktree reads
   and writes main's config dir, log files and report funnel. These are genuine
   backend-identity questions, so they need the design that is the *opposite* of this one's —
   `run-exec.ts`'s asymmetry ("picking the wrong one silently is worse than refusing") applies.
5. **`handle-op-profiling.ts`** groups the op Gantt on `r.worktree ?? r.branch`, so every
   build/push/check from a worktree lands on main's row even though the record already carries
   `opSlug`. One-line fix, but it re-groups records already on disk.
6. **`spawnPassthrough`/`spawnCaptured` with an omitted `env`** give the child the process-*start*
   snapshot rather than current `process.env` (bun 1.3.13) — so any in-process env correction is
   invisible to children. Changing the default touches ~82 call sites and would newly leak
   `SINGULARITY_BUILD_ID` (which `hermetic-build.ts` assumes cannot leak) and the
   `__barrel_import_stub__` sentinel (which fails `NAMESPACE_RE`, so `currentWorktreeName()` would
   throw). Needs its own consumer audit.

## Verification

All commands run from `.claude/worktrees/att-1788856801-y7ze`, whose shell carries the poisoned
`SINGULARITY_WORKTREE=singularity` and which has **never been built** — so the defect's signature
here is a *green* run.

**0. Capture the defect first, on a clean tree.**
```
env | grep '^SINGULARITY_WORKTREE'          # SINGULARITY_WORKTREE=singularity
git rev-parse --show-toplevel               # .../worktrees/att-1788856801-y7ze
./equin run plugins/primitives/plugins/dom/plugins/overscroll-hint/e2e/overscroll-hint-verify.ts
```
Today: `ALL CHECKS PASSED`, having driven — and config-reverted — `http://singularity.localhost:9000`.

**1. Unit level, no deploy needed.**
```
./equin test plugins/infra/plugins/paths/core/internal/checkout-deploys.test.ts
./equin test plugins/framework/plugins/cli/plugins/op-runtime/core/internal/build-receipt.test.ts
```
The first must cover: main's checkout → `singularity` first, then `sonata`; a never-built worktree
→ `{kind:"none", others:[]}`; a composition-only worktree → `{kind:"none", others:[sonata.att-x]}`;
a spec whose `server` is `central-core` → excluded; a spec with no `composition` key → main app; a
non-namespace directory name → skipped, not thrown; **a directory with no `spec.json` → skipped
even when no match is found**; a malformed spec with a match present → warned; a malformed spec
with no match → throws naming the path; a symlinked root → still matches.

**2. The headline case — the unbuilt worktree must refuse.**
```
./equin run plugins/.../overscroll-hint-verify.ts; echo "exit=$?"
```
Expect `exit=2` and the "No deploy for this checkout" block — **not** `ALL CHECKS PASSED`, and
main's config untouched.

**3. The env is provably inert.**
```
SINGULARITY_WORKTREE=singularity SINGULARITY_E2E_BASE=http://singularity.localhost:9000 \
  ./equin run plugins/.../overscroll-hint-verify.ts; echo "exit=$?"
rg -n 'process\.env' plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/
```
Byte-identical output to step 2; the `rg` prints nothing outside `args.ts`.

**4. Positive path.**
```
./equin build
./equin run plugins/.../overscroll-hint-verify.ts
```
Expect the `target:` line naming `http://att-1788856801-y7ze.localhost:9000` and the build id, then
`ALL CHECKS PASSED`. Cross-check the two independent records agree:
```
python3 -c "import json;print(json.load(open('$HOME/.singularity/worktrees/att-1788856801-y7ze/build-status.json'))['buildId'])"
curl -s http://att-1788856801-y7ze.localhost:9000/.build-id
```

**5. The assert fires (negative tests).**
```
cp ~/.singularity/worktrees/att-1788856801-y7ze/web/.build-id /tmp/bid.bak
printf 'build-not-mine\n' > ~/.singularity/worktrees/att-1788856801-y7ze/web/.build-id
./equin run plugins/.../overscroll-hint-verify.ts; echo "exit=$?"     # WRONG DEPLOY, non-zero
mv ~/.singularity/worktrees/att-1788856801-y7ze/web/.build-id /tmp/bid2
./equin run plugins/.../overscroll-hint-verify.ts; echo "exit=$?"     # "fell through to index.html"
mv /tmp/bid2 ~/.singularity/worktrees/att-1788856801-y7ze/web/.build-id
```
The second is the SPA-fallback trap (`200 text/html 265869B`) and must not be mistaken for a build
id. Then hand-edit the receipt's `status` to `failed` and confirm the run **warns and proceeds**
rather than refusing.

**6. Explicit targets and the composition case.**
```
./equin run plugins/.../overscroll-hint-verify.ts --url http://singularity.localhost:9000  # passes, identity skipped
./equin run plugins/.../overscroll-hint-verify.ts --url http://x:9000 --composition sonata # usage error
./equin build --composition sonata
./equin run plugins/.../overscroll-hint-verify.ts; echo "exit=$?"      # refuses, lists sonata.att-…
./equin run plugins/.../overscroll-hint-verify.ts --composition sonata # targets sonata.att-…
```

**7. The backstops earn their keep.** Before step 11's fixes, the new check must FAIL naming
`mailbox-tabs-verify.ts`; after, it passes. Run
`bun x eslint plugins/framework/plugins/tooling/plugins/web-artifacts/check/index.ts` to prove
`no-laundered-checkout-namespace` is loaded (a typo'd `enforceEverywhere` id throws at config
load) and that the last laundering is gone.

**8. Fleet smoke — one at a time** (the harness forbids concurrent e2e runs):
`data-view/e2e/control-panels.ts`, `pane/e2e/deep-link-restore.ts` (a module-top-level `pathUrl`
binder), `reports/e2e/fan-out-ceiling.ts` (proves the `agentFetch` wiring point),
`reorder/e2e/claim-verify.ts` (the only `requirePage` caller).

**9. The whole gate.** `./equin check` — must include a green **`plugin-boundaries`**
(proving `e2e → paths/core`, `e2e → op-runtime/core` and the new `paths/core → spawn/core` edge
are legal and acyclic, and that nothing reached `paths/server`), plus `type-check`, `eslint`,
`namespace:no-hand-built-url`, `paths:no-inlined-worktree-artifacts`, `web-artifacts:map-in-sync`
and `plugins-registry-in-sync`.
