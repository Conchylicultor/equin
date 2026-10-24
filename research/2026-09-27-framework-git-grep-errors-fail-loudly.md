# Check scans: a `git grep` that did not run must fail, not pass

## Context

`gitGrepList` (`plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts`) is the one
`git grep -l` choke point behind `grepCode`, `grepImports`, `listCandidateSources` and the check
cache's replay hook (`runner.ts` → `validate` → `replayQuery`). The `no-adhoc-git-grep` lint routes
every check's git grep through it.

It reads any non-zero exit with empty stdout as "no matches":

```ts
if (result.exitCode !== 0 && stdout === "") return [];
```

`git grep` exits **1** for "no matches", but **128** for a malformed pattern, bad pathspec, bad
tree-ish, etc. Those come back as `[]`, so a check whose pattern never compiled reports PASS. It
happened with `type-scale:closed-role-ladder` (unescaped `var\(`), and any existing check could be
passing vacuously today. Same file, same class of hole:

- **Timeout.** `spawnCaptured` returns `timedOut: true` as a result (not a throw). A killed grep can
  carry *partial* stdout, which is currently returned as a complete candidate list.
- **`readTreeBlobs`** never looks at `git cat-file --batch`'s exit code / `timedOut`; a failed or
  truncated batch yields a short map, and `readCandidates` silently `continue`s past the missing
  candidates. A framing desync `break`s silently too.

## Design

Failure becomes a throw (rung 4, loud runtime failure — the only rung available: whether git
accepted the pattern is known only at runtime). A throw is already the right outcome everywhere
downstream:

- In a check body, `thrown-outcome.ts` turns it into a **fatal, uncached** check failure carrying the
  message (never `inconclusive`, never recorded as a pass).
- In the cache replay hook, `runner.ts` already catches validate throws → cache MISS → the body runs
  and throws → check fails. No runner change needed.

Changes in `grep-code.ts`:

1. **`GitScanError extends Error`** (module-local class, exported from nowhere new unless a test needs
   it — tests assert on the message): carries `argv`, `exitCode`, `timedOut`, `stderr`. Message:
   `git grep failed (exit 128): <stderr first lines> — pattern <grepArg>, pathspecs …` so the check
   author sees exactly why ("fatal: ... Unmatched ( or \(").
2. **`gitGrepList`**: classify the result explicitly:
   - `timedOut` → throw (partial output is not a candidate list).
   - `exitCode === 0` → parse stdout (as today).
   - `exitCode === 1` → `[]` **only if** stdout is empty (exit 1 with output would be incoherent → throw).
   - anything else → throw.
3. **`readTreeBlobs`**: throw on `timedOut` / non-zero exit, and on framing desync (replace the silent
   `break`s). A `<spec> missing` object stays a legitimate skip (the tree simply lacks the path — it
   cannot, since grep listed it from the same tree, but the protocol allows it and it is not an error
   of the scan).
4. Leave the working-tree fallback's per-file `.catch(() => null)` alone? No — narrow it: only an
   `ENOENT` (file deleted between `git grep --untracked` and the read) is a skip; any other read error
   rethrows. (Needed for `no-bare-catch`/`no-absorbed-failure` hygiene anyway.)

Also:

- Update the stale comment in `plugins/ui/plugins/tokens/plugins/type-scale/check/index.ts` (~L291)
  that documents the old "reads as no matches" behavior.
- Update the `gitGrepList` / `readCandidates` doc comments to state the contract: exit 1 = empty,
  every other failure throws.

No cache-key bump: `ReadSet.sourceHash` hashes the check-system source and invalidates input-keyed
read-sets on this logic change; legacy slots are keyed on the tree hash, which this commit changes.

### Sweep for currently-vacuous checks

After the change, run the full `./equin check` (not cached-hit: sourceHash change forces
re-runs). Any check with a broken `grepArg` now fails with the git stderr. Fix each such pattern in
place (escape / correct the ERE). If none fail, the repo had no other vacuous check — report that.

### Out of scope (report as follow-up)

A *well-formed* `grepArg` that doesn't cover `pattern` (pre-filter narrower than the JS regex)
still silently drops matches. The structural fix is deriving the pre-filter from `pattern` (or
dropping the redundant knob); that is a larger API change across every grepCode caller.

## Tests (`grep-code.test.ts`)

- malformed ERE (`grepArg: "var\\(--("`, not fixed) → `grepCode` rejects with a message containing
  `exit 128` and git's stderr.
- same through `listCandidateSources` and `gitGrepList` with a scan tree (bad pattern against a tree).
- bad tree-ish passed to `gitGrepList` → rejects.
- existing "returns [] when git grep finds nothing" stays green (exit 1 path).

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/checks`
2. `./equin check` (full) — all green, or broken patterns found and fixed.
3. Manual negative: temporarily break the type-scale `grepArg` locally, run
   `./equin check type-scale:closed-role-ladder`, see it fail with git's error; revert.
4. `./equin build` (background) → deploy receipt `status: ok`.
