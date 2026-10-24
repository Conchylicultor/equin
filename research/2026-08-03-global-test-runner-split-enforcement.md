# Make the two test runners' split real, not documented

## Context

Root `CLAUDE.md` states an invariant: *"The runner is chosen by where the file
lives, so the two never cross-load."* Nothing enforces it, and it is false.

`vitest.config.ts` scopes itself:

```ts
include: ["plugins/**/web/__tests__/**/*.test.{ts,tsx}"]
```

`bunfig.toml` scopes `bun test` to **nothing**. That asymmetry *is* the bug.
`bun test <plugin-dir>` therefore loads the vitest-only jsdom files and produces
a wall of failures. Observed on `plugins/primitives/plugins/optimistic-mutation`:

| command | result |
| --- | --- |
| `bun test plugins/primitives/plugins/optimistic-mutation` | **20 failures** |
| `bun test .../optimistic-mutation/web/internal` | 57 pass |
| `bun run test:dom plugins/primitives/plugins/optimistic-mutation` | 20 pass |

The cost is not the wasted run. A plausible-looking command produces failures
indistinguishable from real ones, so an agent can "fix" working code to satisfy
it, or move jsdom tests out of `web/__tests__/` where they no longer belong.

The current split is clean by luck, not by construction — a full scan found
**478** test files (413 co-located bun:test, 65 under `web/__tests__/`) with
**zero** violations in either direction, and `.tsx` appearing only under
`__tests__/`. So this is about making a currently-true convention *stay* true and
*be* true at the tool level.

Intended outcome: one sanctioned command that always runs the right runners and
reports both, a `bun test` that can no longer cross-load, and a
`./equin check` entry that fails when any part of that drifts.

## The lever

`bun` 1.3.13 supports a test-path ignore list. The CLI flag is
`--path-ignore-patterns`; the binary also carries the `pathIgnorePatterns`
string alongside its bunfig-parser error text ("`pathIgnorePatterns` must be a
string or array of strings"), the same shape as the known bunfig key
`coveragePathIgnorePatterns`.

**Step 1 of implementation is to confirm empirically** that `[test]
pathIgnorePatterns` is honored from `bunfig.toml` (run the optimistic-mutation
command before and after adding the line). If it is *not* honored, fall back to
registering a `Bun.plugin` `onLoad` in the existing `test/bun-preload.ts` that
replaces any `**/web/__tests__/**` module with an empty one and prints a
one-line notice. Pieces 2–4 below are unaffected either way.

## Piece 1 — restore the symmetry (`bunfig.toml`)

```toml
[test]
preload = ["./test/bun-preload.ts"]
# Exact complement of vitest.config.ts's `include`: vitest owns
# plugins/**/web/__tests__/**, bun:test owns everything else. The pair is bound
# by the `test-layout:runner-split` check — edit neither side alone.
pathIgnorePatterns = ["**/web/__tests__/**"]
```

Deliberately `**/web/__tests__/**`, not the looser `**/__tests__/**`: the ignore
must be the *exact* complement of vitest's include. A stray `core/__tests__/`
suite would otherwise fall in neither runner's scope and silently never run —
the quiet version of the bug being fixed. With the exact pair, such a file stays
loud under `bun test` until the check (rule **c** below) rejects it.

## Piece 2 — a plugin that owns the split

New leaf plugin `plugins/framework/plugins/tooling/plugins/test-layout/`. It owns
the canonical split as data (`core/`, importable) and enforces it (`check/`).
One plugin, so the constants and their enforcement cannot separate.

- **`core/index.ts`**
  - `DOM_TEST_INCLUDE = "plugins/**/web/__tests__/**/*.test.{ts,tsx}"` — verbatim vitest include
  - `BUN_TEST_IGNORE = "**/web/__tests__/**"` — verbatim bunfig ignore
  - `TEST_FILE_GLOB = "**/*.test.{ts,tsx}"`
  - `isDomTestPath(repoRelPath): boolean` — the one predicate
  - `partitionTestPaths(files): { bun: string[]; dom: string[] }`
- **`core/test-layout.test.ts`** — bun:test for the classifier; dogfoods its own
  rule by living next to source.
- **`check/index.ts`** — default-exports a `Check` (id `test-layout:runner-split`,
  per the contributed-check `<plugin>:<id>` convention). Discovery is automatic:
  `./equin build` regenerates `checks/core/check.generated.ts` from the
  filesystem — **no registry edit, and the regenerated file must be committed.**

The check asserts four things, reporting every offender as `file:line` in the
`{ ok: false, message, hint }` shape used by
`checks/plugins/no-raw-event-source/check/index.ts`:

- **a.** no `*.test.ts(x)` **outside** `web/__tests__/` imports `vitest`
- **b.** no `*.test.ts(x)` **under** `web/__tests__/` imports `bun:test`
- **c.** no `*.test.ts(x)` sits under a `__tests__/` dir that is not
  `plugins/**/web/__tests__/` (in neither runner's scope)
- **d.** `bunfig.toml` still contains `BUN_TEST_IGNORE` and `vitest.config.ts`
  still contains `DOM_TEST_INCLUDE` — a substring assert, not a parse. Deleting
  or editing one scope literal fails with a message naming the other.

Rule **a** is the direct guard on the reported bug; **d** is what makes it
structural — the fix cannot be silently removed later.

A lint rule was considered and rejected: rule files are dual-loaded under jiti,
which cannot resolve `@plugins/*`, so a rule could not import `core/` and would
have to duplicate the constants plus add an in-sync check anyway. One check does
the whole job, runs under Bun, and is the mechanism `CLAUDE.md` already
advertises.

Reuse `grepCode` / `listCandidateSources` from
`@plugins/framework/plugins/tooling/plugins/checks/core` for the file sweep if
they are exported there (they back the existing pattern checks); otherwise
`Bun.Glob().scan()`. Do **not** hand-roll `git grep` — the `no-adhoc-git-grep`
lint rule forbids it.

## Piece 3 — `./equin test [path...]`

New `plugins/framework/plugins/cli/bin/commands/test.ts`, registered as
`registerTest(program)` in `bin/cli.ts` alongside `registerCheck`. This is the
one sanctioned entry point.

- Zero or more path args (file or dir); no args ⇒ the whole `plugins` tree.
  That finally provides the run-everything target the docs said didn't exist.
- Enumerate `*.test.ts(x)` under each arg, partition with `partitionTestPaths`.
- Run `bun test <original args>` if the bun bucket is non-empty, then
  `vitest run <original args>` if the dom bucket is non-empty. Pass the **user's
  original paths** to each runner, not the enumerated file list — both accept
  path filters, output stays familiar, arg lists stay short.
- Sequential, not concurrent: interleaved output from two runners is unreadable.
- Stream both through `spawnPassthrough` from
  `@plugins/infra/plugins/spawn/core` (the sanctioned inherit-streams spawn;
  `check.ts` already imports from that barrel).
- Exit non-zero if either runner failed.
- **Always print a summary naming both buckets, including an empty one:**

  ```
  bun:test   57 files   exit 0
  vitest     no jsdom tests under this path
  ```

  That empty-bucket line is the point. After Piece 1, `bun test <plugin-dir>` is
  correct but *partial* — green while 20 jsdom tests never ran. Only a command
  that knows about both runners can say so out loud.

Keep the command surface minimal for v1: paths only. Forwarding extra flags
(`-t`, `--bail`) to both runners is an easy follow-up if wanted.

## Piece 4 — make the docs describe the mechanism

- **Root `CLAUDE.md` → Testing**: rewrite around `./equin test <path>` as
  the default. Keep the two direct commands documented as the narrow-targeting
  escape hatches. Delete the two now-false claims: *"the two never cross-load"*
  (state instead that the bunfig ignore is the exact complement of the vitest
  include, bound by `test-layout:runner-split`) and *"a bare `bun test` would
  load the vitest files and fail"*.
- **`vitest.config.ts`**: its comment carries the same false guarantee — replace
  with the real mechanism and the check's name.
- **`bunfig.toml`**: the mirror comment, per Piece 1.
- **`plugins/framework/plugins/cli/CLAUDE.md`**: add `test` to the command table.
- New plugin `CLAUDE.md` for `test-layout`.
- Per-plugin `CLAUDE.md` files documenting a `bun test …` + `bun run test:dom …`
  pair (optimistic-mutation and ~17 others) stay valid — leave them; converting
  them to `./equin test` is an optional follow-up.

## Files

| Path | Change |
| --- | --- |
| `bunfig.toml` | add `pathIgnorePatterns` + comment |
| `plugins/framework/plugins/tooling/plugins/test-layout/core/index.ts` | new — canonical split |
| `.../test-layout/core/test-layout.test.ts` | new — bun:test for the classifier |
| `.../test-layout/check/index.ts` | new — the `runner-split` check |
| `.../test-layout/{package.json,CLAUDE.md}` | new — plugin metadata |
| `plugins/framework/plugins/cli/bin/commands/test.ts` | new — the command |
| `plugins/framework/plugins/cli/bin/cli.ts` | register `registerTest` |
| `plugins/framework/plugins/tooling/plugins/checks/core/check.generated.ts` | regenerated by build — commit |
| `CLAUDE.md`, `vitest.config.ts`, `plugins/framework/plugins/cli/CLAUDE.md` | doc/comment corrections |

## Verification

Run from the worktree root.

1. **The reported bug is gone.**
   `bun test plugins/primitives/plugins/optimistic-mutation` → 57 pass, 0 fail
   (was 20 failures); the `web/__tests__` file is not loaded.
2. **The vitest side is untouched.**
   `bun run test:dom plugins/primitives/plugins/optimistic-mutation` → 20 pass.
3. **The sanctioned command runs both.**
   `./equin test plugins/primitives/plugins/optimistic-mutation` → both
   buckets green, summary lists `bun:test` and `vitest` with counts.
4. **The empty bucket is stated, not implied.**
   `./equin test plugins/framework/plugins/tooling/plugins/test-layout` →
   bun bucket runs, summary says *no jsdom tests under this path*.
5. **No-arg run works.** `./equin test` → whole tree, both runners.
6. **The check passes, then fails on each drift** (revert each after):
   - `./equin check test-layout:runner-split` → ok
   - add `import { describe } from "vitest";` to a co-located `*.test.ts` → fails naming that `file:line` (rule a)
   - add `import { test } from "bun:test";` to a `web/__tests__` file → fails (rule b)
   - create `plugins/<x>/core/__tests__/foo.test.ts` → fails (rule c)
   - delete the `pathIgnorePatterns` line → fails naming `vitest.config.ts` (rule d)
7. **Own tests + full gate.**
   `bun test plugins/framework/plugins/tooling/plugins/test-layout` → classifier tests pass.
   `./equin build` → regenerates `check.generated.ts` (commit it), runs all
   checks green, and redeploys.
