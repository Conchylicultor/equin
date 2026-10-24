# A host-global audit stops gating per-worktree builds

## Context

`paths:no-undeclared-data-dirs` compares two things with different lifetimes:

- **Its subject** is `~/.singularity/`, one directory shared by every worktree on
  the machine. It holds the union of every branch that has ever run here.
- **Its rule** is `getDataDirs()` — the declarations in *this* checkout, i.e.
  whatever one branch happens to be rebased onto.

So a directory created by any other live worktree is undeclared as far as this
checkout can tell, and the check fails. Observed 2026-08-30 in worktree
`att-1788099811-aioc` (build `772e5bb83-1788113776938`):

```
paths:no-undeclared-data-dirs ... FAIL
  state/agent-write-ledger — inside a kind directory but not a declared `state/agent-write-ledger`
```

`state/agent-write-ledger/` had been written minutes earlier by a concurrently
running worktree, `att-1788090600-s2nq`, whose own branch declared it correctly
in `plugins/config_v2/data-dirs/index.ts` — but that branch had not merged yet,
so nothing in the failing checkout could know. Result: `BUILD FAILED — checks`,
nothing deployed, and no repair available from the failing worktree: the
directory belongs to another agent's live session, so there is nothing safe to
delete and nothing legitimate to declare. It cleared only when the other branch
landed and this worktree rebased — a full build cycle plus the round trip to
work out that the failure was foreign.

This reproduces for every worktree running concurrently with any branch that
introduces a new data dir, for as long as that branch is unmerged. The more
parallel agents, the more often it fires.

### Why the gate has little left to protect

The sibling check `paths:data-root-not-joined` is **tree-scoped** and bans every
spelling that could mint an undeclared directory (`join(dataRoot(), …)`, the
concatenation form, re-reading `SINGULARITY_DIR`). Its own comment calls itself
"the same invariant moved forward in time… before any build runs". New orphans
are therefore already stopped by a check that *cannot* fail on foreign state.

What the filesystem read still catches is **history**: directories from old code,
from non-TS writers, from branches long gone. Those are facts about the machine.
No per-worktree build caused them, and none can fix them.

### The intended outcome

Two changes, one per half of the mismatch:

1. **The verdict stops being asserted by a caller that cannot see its subject.**
   `Check.scope` already exists to answer "which callers can meaningfully assert
   this verdict". Neither existing value fits: `tree` means the tree hash covers
   it, `deploy` means it is about the dist this build just produced. This
   check's subject is the *machine*. A third value, `host`, says so, and `build`
   stops running it.

2. **The rule becomes as host-global as the root it polices.** Each namespace
   publishes the set it declares; the audit reads the union, so an entry another
   live worktree owns is recognised and reported as such instead of failing.

Deliberately **not** in scope (decided 2026-09-01): a scheduled job filing a
report. The check keeps running on a standalone `./equin check`, which
runs every scope when no filter is given.

---

## 1. `host` — a third check scope

### `plugins/framework/plugins/tooling/core/types.ts`

```ts
export const CHECK_SCOPES = ["tree", "deploy", "host"] as const;
```

Extend the `Check.scope` docblock with the third case, in the shape of the two
already there: **`host` → the verdict is about this MACHINE** — the shared data
root, host-global state — and is a function of neither the tree nor the artifact
a build produces. No per-worktree caller can assert it: the subject is shared
with every other checkout on the box and is *ahead of* any one branch, so a
worktree observing it sees state it did not create and cannot repair. Its homes
are a standalone `./equin check` and any host-singleton runner.

### `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`

**Generalise the load-time assertion.** It currently reads:

```ts
if (scopeOf(check) === "deploy" && check.cacheSignature === undefined) {
```

The invariant it enforces is "the tree hash does not cover this check's
subject", which is true of *every* non-tree scope — but it is written as a
literal, so a `host` check would silently get no enforcement at all. Change the
condition to `scopeOf(check) !== "tree"` and reword the message in terms of the
actual scope (`${scopeOf(check)}`), not the word "deploy".

**Widen selection to a set of scopes.** `RunChecksOptions.scope` is a single
`CheckScope`, filtered by equality at line ~227. `build` needs to say
"tree *and* deploy", so:

- `scope?: CheckScope | readonly CheckScope[]`, normalised to an array once and
  filtered with `.includes(scopeOf(c))`.
- The existing "Excluded by --scope …" diagnostic joins the requested scopes.
- `alwaysRun` continues to compose as an AND, untouched.

### The CLI and the subprocess

- `plugins/framework/plugins/cli/plugins/check/cli/index.ts` — the `--scope`
  help text interpolates `CHECK_SCOPES.join(" | ")` (auto-extends) but then
  spells out one sentence per value. Add the third, and document that the flag
  now takes a comma-separated list.
- `plugins/framework/plugins/cli/plugins/check/cli/run.ts` — validation already
  tests membership of `CHECK_SCOPES` generically; make it split on `,` and
  validate each part, keeping the existing "Unknown --scope" error.
- `plugins/framework/plugins/cli/plugins/op-runtime/cli/check-subprocess.ts` —
  `select?.scope` widens to the same union, and argv joins with `,` at the
  single `argv.push("--scope", …)` site. Its top docblock enumerates "the three
  callers and what each asserts"; update that prose.

### The callers

- **`plugins/framework/plugins/cli/plugins/build/cli/run.ts`** (`fullChecksJob`,
  ~line 1240) passes no `select` at all today, with a comment explaining that
  build is the one caller that *can* assert `deploy`. It becomes
  `select: { scope: ["tree", "deploy"] }`, and the comment gains the other half:
  build asserts the tree it built from and the dist it produced; it does not
  assert the machine, whose data root is shared with every checkout on the box.
  **This is the line that fixes the reported bug** — without it, build's absent
  filter would keep running the host check.
- **`push`** (`push/cli/run.ts:178`) stays `select: { scope: "tree" }`. It was
  already unaffected — which is why the incident cost a build, never a merge.

### `plugins/infra/plugins/paths/check/index.ts`

`scope: "deploy"` → `scope: "host"` on `noUndeclaredDataDirsCheck`, and reword
the `scope` comment above it. The existing `cacheSignature()` stays and is now
required by the generalised assertion rather than by a literal.

The other two `deploy` checks (`web-artifacts:map-in-sync`,
`web-artifacts:no-vendored-state-inlined`) are correctly classified — their
subject really is this worktree's dist. They do not move.

---

## 2. Each namespace publishes what it declares

### The artifact

Add to `worktreeArtifacts` in
`plugins/infra/plugins/paths/core/internal/paths.ts`:

```ts
/**
 * What this namespace's checkout DECLARES under the data root … no `<id>`
 * variant: a namespace has exactly one declared set, and the file's job is to
 * be found at a fixed path by an audit running in a different checkout.
 */
dataDirs: (name: Namespace): string =>
  join(worktreeDataDir(name), "data-dirs.json"),
```

Same category as `spec` and `buildStatus` — a fixed-path record, not a per-run
artifact. Two properties come free:

- `removeWorktreeSpec` (`infra/worktree/server/internal/spec.ts`) already
  recursively removes `worktreeDataDir(name)`, so the file dies with the
  namespace. Its lifetime is exactly "this namespace can still write to the
  root".
- `pruneWorktreeBuildArtifacts` only matches the build/release/check filename
  families, so it will not reap this. **Verify** when implementing.

Add a pattern to `WORKTREE_ARTIFACT_PATTERNS` in the same check file
(`{ pattern: /["'`]data-dirs\.json/, grepArg: "data-dirs.json" }`) so the
filename cannot be re-inlined by a second reader — the exact drift that check
exists to stop.

### Shape

Mirror the two sets the audit derives locally, so rules 1 and 3 stay symmetric:

```jsonc
{
  "namespace": "att-1788090600-s2nq",
  "writtenAt": "2026-09-01T…",
  // `${kind}/${name}` — what rule 3 (second level) compares against.
  "keys": ["state/config", "state/agent-write-ledger", "locks/cpu", …],
  // First path segment of every declaration carrying a `legacyLocation` —
  // what rule 1 (top level) compares against.
  "rootEntries": ["postgres", "sockets", …]
}
```

`keys` must come from the **evaluated** registry, not from parsing source:
`plugins/infra/plugins/host-admission/data-dirs/index.ts` derives one `locks/<id>`
declaration per entry of `RESERVED_POOLS`, so a name is not always a literal in
the file. This is the reason the published-set approach was chosen over grepping
sibling checkouts.

### Writer

`plugins/infra/plugins/paths/server/index.ts` is currently
`export default {} satisfies ServerPluginDefinition`. Give it an `onReady` that
loads the collected dir and writes the file atomically (tmp + rename):

```ts
await loadCollectedDir<DataDir>(dataDirsEntries, { isItem, dedupeKey, label });
// then getDataDirs() → keys + rootEntries → worktreeArtifacts.dataDirs(currentWorktreeName())
```

This is the same `loadCollectedDir(dataDirsEntries, …)` call the check already
makes at `check/index.ts:~511`; lift the shared `isItem` / `dedupeKey` / key
derivation into `core/internal/` so both callers use one spelling.

Notes:

- **The backend, not a warm-up.** `defineWarmup` documents itself as "an
  OPTIMIZATION, never a correctness dependency — a throw is logged and the drain
  continues". A missing manifest silently un-attributes a namespace, so this is
  not that category. It is ~28 tiny dynamic imports and one small write.
- **The backend, not the build** — the backend is the process that actually
  creates these directories, and it exists for every live namespace including
  ones that boot without a fresh build.
- Skip when `isRelease()` — a release runs against its own data root.
- Verify the new import edge (`paths/server` →
  `@plugins/framework/plugins/tooling/plugins/collected-dir/core`) with
  `./equin check plugin-boundaries`.

---

## 3. The audit reads the union

In `noUndeclaredDataDirsCheck.run()`:

- Read every `worktreeArtifacts.dataDirs(n)` for `n` in the worktrees dir
  listing, excluding this namespace. Build `foreign: Map<string, string[]>`
  (key → the namespaces declaring it). A malformed or absent file is skipped,
  not fatal — an unattributed entry simply falls through to the existing
  failure.
- **Rule 1**: an otherwise-undeclared top-level entry present in any namespace's
  `rootEntries` is attributed, not an offender.
- **Rule 3**: an otherwise-undeclared `${kind}/${child}` present in any
  namespace's `keys` is attributed, not an offender.
- Report attribution beside the existing drained-count line:

  ```
  paths:no-undeclared-data-dirs: 1 entr(ies) under /Users/…/.singularity are declared by
    another live worktree, not by this checkout — state/agent-write-ledger (att-1788090600-s2nq).
    They will stop appearing here once that branch merges.
  ```

- **Extract the verdict as a pure function.** Move the rule evaluation to
  `core/internal/data-root-audit.ts` taking
  `(observation, localKeys, localRootEntries, foreign)` and returning
  `{ offenders, attributed, drained, drainable }`. The check becomes I/O plus a
  call. This is what makes the new logic unit-testable without touching the real
  root — the co-located `data-dir.test.ts` / `legacy-layout.test.ts` are the
  precedent.

- **`cacheSignature()` must cover attribution.** It currently folds in the root
  listing, each kind listing, and each legacy node. Add one entry per published
  manifest — `${namespace}:${mtimeMs}:${size}` from a `stat`, no parse — so a
  PASS recorded while a foreign checkout excused an entry cannot outlive that
  checkout's removal. Without this, the deploy-scope trap the existing docblock
  warns about ("a cached PASS that outlives the state it was about") reappears
  through the new input.

- **Failure hint.** Add one sentence: an entry can belong to another live
  worktree whose branch has not merged; such an entry is recognised
  automatically once that worktree's backend has booted, so an *unattributed*
  entry means no live namespace on this machine declares it. This was most of
  the original diagnosis cost — the hint reads today as though the current
  branch has an undeclared writer.

---

## 4. Docs

- `plugins/infra/plugins/paths/CLAUDE.md` — the paragraph describing the check
  ("reads the REAL root and fails on any top-level entry that is neither
  declared nor grandfathered") gains the host scope and the union, plus a line
  on the published manifest under "Adding a new data dir".
- `docs/plugins-details.md`, `docs/plugins-compact.md` and the per-plugin
  `CLAUDE.md` reference blocks regenerate from `./equin build` — do not
  hand-edit; `plugins-doc-in-sync` fails on drift.

---

## Verification

Run in order, from the worktree:

1. `./equin build` (background — regenerates docs/registries and deploys).
2. `./equin check --list` — `paths:no-undeclared-data-dirs` prints as
   `[host]`; the two `web-artifacts` checks still print as `[deploy]`.
3. `./equin check --scope tree` (push's pass, unchanged),
   `./equin check --scope tree,deploy` (build's new pass — the host check
   must be absent), `./equin check --scope host` (only the audit).
4. `./equin check --scope nonsense` — still exits 1 naming all three
   valid scopes.
5. `./equin check paths:no-undeclared-data-dirs` — passes, and prints the
   attribution line. This machine has 73 registered namespaces, so several
   manifests should exist once their backends have booted.
6. Confirm the build no longer runs it: after step 1, the build's
   `~/.singularity/worktrees/<wt>/check-<buildId>.log` contains no
   `paths:no-undeclared-data-dirs` line.
7. **Reproduce the original failure end to end.** `mkdir
   ~/.singularity/state/zz-verify-foreign`; the standalone audit fails on it.
   Add `"state/zz-verify-foreign"` to another namespace's
   `~/.singularity/worktrees/<other>/data-dirs.json` `keys`; the audit now
   passes and names that namespace in the log line. Remove both afterwards, and
   re-run to confirm the failure returns.
8. `./equin test plugins/infra/plugins/paths` — the new pure-function
   tests for attribution plus the existing co-located suites.
9. `./equin check plugin-boundaries` — the new `paths/server` →
   `collected-dir/core` edge is legal and forms no cycle.

## Risks

- **Attribution is blind until backends republish.** Until a namespace's backend
  boots with this change, it publishes nothing and its dirs stay unattributed.
  Consequence is a truthful-but-unhelpful line in an audit nobody's build
  depends on any more — not a broken build. Self-heals as worktrees restart.
- **Widening `select.scope` touches the check plumbing** used by both `build`
  and `push`. Mitigated by push keeping its exact single-value call, and by
  steps 3–4 above exercising every selection form.
