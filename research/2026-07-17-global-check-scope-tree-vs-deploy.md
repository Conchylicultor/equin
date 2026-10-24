# Check scope: `tree` vs `deploy` — unbreaking push's rebase

## Context

`./equin push` fails its check phase with `web-artifacts:map-in-sync`
("Run `./equin build`") on any push whose internal rebase moves the tree
past the deployed dist. The agent **cannot pre-empt it**: main can move again
between a rebuild and push's own internal rebase, so rebuild+re-push is a race
whose starting gun is inside push itself. Hit on the first real push after the
artifact-mode flip (2026-07-16).

### Root cause — a categorical mismatch, not a timing bug

Push runs its checks **after** its internal rebase, deliberately:

```
commit → fetch → ff main → git rebase main --exec … → bun install
       → postRebaseNormalize → runRebasedChecks → push branch → ff main → push main
```

with the comment at push.ts step 4: *"Run checks on the rebased tree — this is
exactly what will land on main."* That contract is right. The problem is that
**one check in that pass measures something that never lands on main**:

- `git check-ignore -v plugins/framework/plugins/web-core/dist` → `.gitignore:22`
- `git ls-files plugins/framework/plugins/web-core/dist` → **0 files**
- the artifact store lives at `~/.singularity/web-artifacts/` — outside any git repo

The dist and its import map are a **local, per-worktree deploy artifact**. Push
gates the merge on an artifact outside the push payload. And post-rebase the
dist is stale *by construction* whenever main moved — so push can never
meaningfully assert deploy freshness there, no matter how it's fixed.

### The axis already exists, as a workaround

`checks/core/tree-hash.ts:21` hashes the working tree **"honoring .gitignore"**.
So the same `.gitignore` fact that keeps the dist out of the push payload also
keeps it out of the check **cache key** — which is exactly why `map-in-sync` had
to hand-roll `cacheSignature()` as `sha256(marker + html + storeMtime)`. Both
web-artifacts checks already carry this workaround. We are naming a distinction
the code has already been forced to make.

### Intended outcome

Push's contract collapses to one sentence: **push gates the merge on the push
payload.** The deploy property keeps its three real homes — `build` (which
deploys, then verifies), standalone `./equin check`, and main's post-push
auto-build.

---

## Design

Add a **scope axis** to `Check`, defaulting to `"tree"`. Push filters its
subprocess to `--scope tree`. Both web-artifacts checks become `"deploy"`.

```ts
export type CheckScope = "tree" | "deploy";
```

- **`tree`** (default) — verdict is a function of the tree hash ⇒ in the push payload.
- **`deploy`** — verifies the local, gitignored deployment `build` produces
  (`web-core/dist`, the `~/.singularity/web-artifacts` store), which never lands on main.

Push selects **by property, never by id** (collection–consumer separation): the
string `map-in-sync` must not appear anywhere under `plugins/framework/plugins/cli/`.

### Why dropping it from push loses nothing real

- **Merge safety: zero.** The dist never lands on main.
- **"Agent never built at all" is already covered, tree-scoped.** The codegen
  in-sync checks (`barrel-stubs-in-sync`, `config-origins-in-sync`,
  `reorderable-slots-in-sync`, `token-group-vars-in-sync`, …) all fail on a
  never-built tree. `map-in-sync` is redundant for that case.
- **Main's deployment self-heals.** `plugins/tasks/server/internal/push-watcher.ts:45`
  — *"auto-build runs regardless of trailers"*. Main's dist freshness is
  guaranteed by main's auto-build, and *that* build runs `map-in-sync` for real.
- **Residual sliver:** agent built → edited a `.tsx` body → pushed. It's a
  *post-hoc detector of a review that already happened*, and its prescribed fix
  produces a dist nobody will open.
- **Bonus:** push gets ~2–3s faster. Because `cacheSignature()` returns `null`
  under `isBuildInProgress()`, build **never records a cached pass** for
  `map-in-sync` — so push runs it cold today, every time, inside the global mutex.

### Rejected alternatives

- **(b) Run deploy checks pre-rebase in push.** Same `null`-signature fact means
  it would run **cold on every push** (bun boot + full check module graph +
  re-planning ~928 artifacts ≈ 3–5s) inside the host-wide push mutex, forever,
  to re-assert what was already true when the agent built. It is a milder
  instance of the conflation (c) is rejected for: *push is not a deploy* — and
  that reason doesn't weaken just because the work is cheaper.
- **(c) Recompose inside `postRebaseNormalize`.** Four independent defects:
  (1) it **manufactures the evidence** — building a dist the agent will never
  open doesn't restore "the agent reviewed a fresh app", it just turns the check
  green; (2) it burns cores with **no host-admission grant** (normalize runs
  before `withHostGrant`); (3) **~150s tail** — a `builderSourceDigest` change on
  main invalidates the whole fleet, and every agent queued on the single-slot
  mutex pays it; (4) every branch of `postRebaseNormalize` ends at
  `git commit --amend` — the dist has nothing to amend.
- **(d) Per-file attribution of staleness.** Collapses to (a) exactly when it
  matters: a builder-identity change alters **every** entry, all attributable
  upstream ⇒ it excuses the entire fleet, at maximum complexity. Also
  many-to-one and ambiguous (each specifier hashes a whole input closure), and
  reintroduces a git-history read ⇒ `cacheSignature` → `null` ⇒ never cached.

### The invariant that makes `scope` load-bearing

- `scope: "tree"` ⇒ tree hash covers the subject ⇒ absent `cacheSignature` is correct.
- `scope: "deploy"` ⇒ tree hash **does not** cover the subject ⇒ the check
  **MUST** supply a `cacheSignature()` (or return `null`).

**Enforce at load, fail loudly** (~4 lines in the runner's check loading): a
`deploy` check without `cacheSignature` would record a deploy verdict under a
tree-only key → a permanently stale cached pass. Throw.

Both existing web-artifacts checks already satisfy this — they had to, and
hand-rolled it. Independent evidence the classification is right.

---

## Files to modify

**`plugins/framework/plugins/tooling/core/types.ts`**
- Add `export type CheckScope = "tree" | "deploy";`
- Add `scope?: CheckScope;` to `Check` (line ~37), doc-commented in the register
  of the existing `alwaysRun` / `cacheSignature` comments: what each value means;
  that `deploy` names the local gitignored deployment that never lands on main;
  that consumers select **by this property, never by id**; and the
  `cacheSignature` obligation above.

**`plugins/framework/plugins/tooling/core/index.ts`**
- Add `CheckScope` to the `export type { … }` line.

**`plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`**
- `RunChecksOptions.scope?: CheckScope` — "restrict the run to checks of this
  scope; omitted = every scope."
- Apply the filter **after** id resolution so the existing `Unknown check(s)`
  message is unaffected. An explicitly-named id excluded by scope is a caller
  error → **loud, distinct message**, never a silent drop.
- Normalize the default (`c.scope ?? "tree"`) **here only** — no consumer duplicates it.
- Add the deploy⇒`cacheSignature` load guard.
- Note the empty-selection footgun: `runChecks([])` falls through to running
  **all** checks, and `Promise.all([])` → vacuous pass. The loud error above is
  what prevents a mis-typed selection passing silently.

**`plugins/framework/plugins/cli/bin/commands/check.ts`** (options at lines 32–33)
- `.option("--scope <scope>", …)`, validated against the union — **reject an
  unknown scope loudly**, never fall through to running everything.
- Thread into the existing `runOpts` (line ~85, used at line 92).
- `--list` prints each check's scope (makes the classification auditable).

**`plugins/framework/plugins/cli/bin/commands/push.ts`**
- `runChecksSubprocess` (line ~73): add `"--scope", "tree"` to the spawn argv.
  This single edit covers **both** the worktree and `--from-main` paths — both
  route through `runRebasedChecks`.
- Update the comment above `runChecksSubprocess` and the step-4 comment to state
  the *why*: the pass is scoped to the push payload; deploy-scoped checks verify
  a local gitignored artifact that never lands on main and that this push's own
  rebase invalidates by construction.

**`plugins/framework/plugins/tooling/plugins/web-artifacts/check/index.ts`**
- `scope: "deploy"` on `mapInSync` **and** `noVendoredStateInlined`; update the file header.
- **Keep `isBuildInProgress()` — `scope` does not subsume it.** They encode two
  orthogonal facts: `run-context` handles *"build races its own publish"* (build
  **must** run deploy checks — it **is** the deploy); `scope` handles *"push is
  not a deploy."* Add a comment so a later reader doesn't delete one as redundant.

### Why `no-vendored-state-inlined` is also `deploy`

Its verdict is a function of `(tree, store)`, not the tree alone — which it
already admits (`cacheSignature() { return storeMtime(); }`). Its subject is the
store at `~/.singularity/web-artifacts/`. Excluding it from push costs nothing
real: at `check/index.ts:269`,

```ts
const present = fleet.targets.filter((t) => hasArtifact(t.dirName));
```

Post-rebase the store holds artifacts for the **pre-rebase** tree, so the
rebased tree's changed plugins have new `dirName`s **absent from the store** and
are filtered straight out. Push scans only unchanged-plugin artifacts — exactly
the ones not in question. Its post-rebase coverage is structurally ~zero today;
marking it `deploy` stops pretending otherwise. Real coverage lives at `build`.

This is a **separable one-line decision** — the map-in-sync fix stands without
it — but leaving it `tree` would make the axis mean "checks that annoy push"
rather than a property.

### Plumbing: CLI flag, not env var

Push spawns a fresh subprocess precisely so check code comes from the rebased
tree — so push must not compute an id list in-process via `listAllChecks()` (it
would read its own stale module cache, the exact thing the subprocess avoids).
The filter is *expressed* by push, *resolved* in the child. `--scope tree`
because it is discoverable (`--help`, `--list`), joins the existing
`--no-cache`/`--list` surface, and is **hand-reproducible**:
`./equin check --scope tree` reproduces push's pass exactly.
(`SINGULARITY_BUILD_IN_PROGRESS` is env-based for the opposite reason — it must
*not* be inherited.)

### Caching

Cache key is **unchanged**: `entryFile(checkId, treeHash, sha256(sig))`. `scope`
is a static selection property, not a run parameter — it must **not** be folded
into `cacheSignature` (two scopes never produce different verdicts for the same
check). No key migration, no invalidation. Deploy checks still cache normally
under build/standalone.

---

## Verification

**Reproduce the failure first** (else the fix proves nothing):
1. On a worktree branch: `./equin build` → green; `./equin check` passes.
2. Land a commit on `origin/main` touching any file in a plugin's artifact closure (any `.tsx`).
3. Without rebuilding: `./equin push` → **must fail** `web-artifacts:map-in-sync`.
4. **Prove the loop:** `./equin build` (green) → land *another* main commit → `push` → fails again. Rebuilding cannot win the race.

**Prove the fix:**
5. Same setup, patched: `push` → check pass lists no `web-artifacts:*` line; merge lands.
6. `git ls-files plugins/framework/plugins/web-core/dist | wc -l` → `0` at the merge commit.
7. Main's auto-build fires post-push and *its* check pass runs `map-in-sync` for real.

**Prove the axis (and no id-naming):**
8. `./equin check --list` → both web-artifacts checks show `deploy`; all others `tree`.
9. `rg -n "map-in-sync" plugins/framework/plugins/cli/` → **no hits**.
10. On a deliberately stale dist: `--scope tree` passes, `--scope deploy` **fails**. Same tree, two verdicts.
11. `./equin check --scope bogus` → non-zero, clear message (not a silent full run).
12. `./equin check web-artifacts:map-in-sync --scope tree` → loud "deploy-scoped, excluded", not a vacuous pass.

**Prove no regression:**
13. Plain `./equin build` on a stale dist still fails `map-in-sync`; `isBuildInProgress()` still suppresses it during the build's own race.
14. A deploy check with `cacheSignature` deleted → load-time throw.
15. `--from-main` path scopes identically (shared `runRebasedChecks`).
16. `./equin build` to regen the `checks` CLAUDE.md autogen block — the new `CheckScope` export changes `Exports:`, and `plugins-doc-in-sync` will fail the push otherwise.

## Follow-up (out of scope)

`build.ts` selects `alwaysRun` checks via `listAllChecks().filter(...).map(c => c.id)`,
needing its own `if (ids.length > 0)` guard because `runChecks([])` runs
everything. Migrating that onto the same runner-side filter would remove the
duplicated default and the footgun.
