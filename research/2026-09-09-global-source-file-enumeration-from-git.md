# Source-file enumeration comes from git, not from a hand-written list of directory names

> **Status (2026-09-10).** The core of this design — `listRepoFiles`, deleting
> both type-check walks, and converting `plugin-boundaries` — landed concurrently
> in `cbf79336e`, written up in
> [`2026-09-09-tooling-check-file-enumeration-from-git.md`](2026-09-09-tooling-check-file-enumeration-from-git.md).
> That is the canonical doc for the enumeration itself. What this change adds on
> top, and what this doc remains the record for:
> - **The program-key hazard (§"The one hazard").** `cbf79336e` did not touch
>   `program-key.ts`, so the gitignored-but-compiled composition registries
>   dropped out of the tsc name census. This change unions them back in.
> - **The shared lint-scope list (§4)** — one constant, so ESLint and the check
>   cannot disagree (`cbf79336e`'s own follow-up).
> - **`no-adhoc-repo-walk` (§5)** — `cbf79336e`'s other stated follow-up.


## Context

`./equin check type-check` has a correctness gate: every file it considers
"lintable" must belong to exactly one tsconfig program, otherwise the check
fails with `N lintable file(s) belong to no tsconfig program`.

The set of lintable files comes from a hand-rolled recursive `readdirSync` walk
that decides what to skip by comparing directory NAMES against a written-down
list: `node_modules`, `dist`, `.git`, `.check-*`, `.claude/worktrees`.

`.cache/` is not on that list. It is gitignored build output — and the
type-check check writes its own `.tsbuildinfo` files into `.cache/tsbuildinfo/`
while walking it. So any `.ts` file that ends up under `.cache/` becomes
"lintable", belongs to no tsconfig program, and fails the check with a message
that has nothing to do with the change being checked. A previous investigation
had to keep its scratch scripts outside the checkout entirely (`/tmp/...`)
because putting them anywhere convenient inside it broke the check.

The instance is `.cache/`. The class is that "what is a source file in this
checkout" is spelled out by hand, from memory, in several places at once — so
every new gitignored directory is a trap the next person discovers by having a
check fail at them.

### How many places, and what they disagree about

| Where | What it enumerates |
|---|---|
| `type-check/check/import-graph.ts` — `IGNORED_DIR_NAMES` + `walkLintFiles` | the lint universe (`.ts`/`.tsx`) |
| `type-check/check/fingerprint.ts` — `IGNORED_DIR_NAMES` + `walkFiles` | every file, behind `readTreeListing` |
| `lint/core/build-lint-config.ts` (~line 351) — the ESLint flat-config `ignores` | what ESLint skips |
| `plugin-boundaries/check/index.ts` — `IGNORED_DIRS` + `walkSourceFiles` | the boundary check's source set |

They already disagree. The ESLint list also ignores `prototypes/**`; the two
walks do not — so a `.ts` under `prototypes/` would fail the coverage gate while
ESLint skipped it. That is the same bug from the other direction, latent today
only because no such file exists yet.

`fingerprint.ts` and the plugin's `CLAUDE.md` both already claim this
consolidation happened — *"It used to be four independent walks … and four
copies of the rules for what to skip"*. The doc is ahead of the code:
`import-graph.ts` still walks the tree a second time, with its own copy.

### The authority already exists, and the check already contradicts it

The check runner's own snapshot is git-derived. `computeTreeHash`
(`checks/core/tree-hash.ts`) does `git add -A` into a throwaway index and
`write-tree`; `loadTreeSnapshot` reads that tree. So the runner's universe is
exactly *tracked + untracked-not-ignored*, gitignored files excluded.

That makes the contradiction concrete: `outer-read-set.ts` records
`view.glob("*.ts")` against that git tree, which would **not** see a
`.cache/x.ts` — while the readdir walk in the same check **does**, and fails the
gate on it. One check, two irreconcilable answers to "what files are there".

`checks/CLAUDE.md` already states the rule for the neighbouring problem
(candidate discovery must go through `listCandidateSources`, which is
scan-tree- and untracked-aware). This enumeration is the same class and simply
never got the same treatment.

### Measurements taken while investigating

- `git ls-files --cached --others --exclude-standard` vs. the current walk:
  **byte-identical** today, for both the `.ts`/`.tsx` lint universe (7671 files)
  and the all-files listing (12796 files) — except two entries, both of which
  the design below closes structurally:
  - the walk emits a bare `.git`, because in a linked worktree `.git` is a FILE
    and the deny-list only tests directories;
  - git emits `.claude/worktrees/claude-1775848273`, a **gitlink (mode 160000)**
    — a nested agent worktree accidentally committed to the index. (This is why
    `git submodule status` errors. Separate finding, see the end.)
- Cost: one `git ls-files` ≈ 0.45 s; the equivalent full walk ≈ 0.29 s. The
  check does **two** walks today, so this is at worst a wash.

### The one hazard: gitignored files that tsc nevertheless compiles

`plugins/framework/plugins/web-sdk/core/web.composition.sonata.generated.ts` and
`web.composition.website.generated.ts` exist on disk in the main checkout and
are gitignored (`.gitignore` carries `*.composition.generated.ts` and
`*.composition.*.generated.ts`).

They are outside the lint universe either way (`isLintable` drops every
`*.generated.ts`). But `program-key.ts` builds `allTsNames`, a name-only census
that **deliberately includes** `*.generated.ts`, because it is the guard against
"a newly added file shadows a module resolution" — and that key decides whether
tsc runs for a target at all. A naive switch to pure git enumeration would drop
those two files from the census and quietly weaken a load-bearing key. Any
design has to answer this.

## Design

One value answers "what files does this checkout contain", it comes from git,
and the two walks are deleted rather than corrected.

### 1. `listRepoFiles` — the one enumeration, in `checks/core`

New `plugins/framework/plugins/tooling/plugins/checks/core/repo-files.ts`,
exported from the `checks/core` barrel alongside `computeTreeHash`:

```ts
export interface RepoFiles {
  root: string;
  /** Repo-relative, sorted, deduped. Every entry is an existing regular file. */
  files: string[];
}

export async function listRepoFiles(root: string): Promise<RepoFiles>;
```

One `spawnCaptured(["git", "ls-files", "-z", "--cached", "--others",
"--exclude-standard"], { cwd: root, timeoutMs })` — the sanctioned spawn
chokepoint, matching the `GIT_TIMEOUT_MS` constants already in `tree-hash.ts` /
`read-set.ts`. Split on `NUL`, then drop anything that is not a regular file on
disk (`statSync(...).isFile()`, with a caught `ENOENT`).

That single filter closes both edge cases without naming either:

- a **tracked-but-deleted** file (still listed by `--cached`) fails the stat;
- a **gitlink** (`.claude/worktrees/claude-1775848273`) is a directory on disk,
  so `isFile()` is false. No mode-160000-aware code anywhere.

The bare `.git` anomaly disappears on its own: git never tracks `.git`, so it
never appears in the output.

**This one fails LOUD, unlike its neighbours.** `computeTreeHash` and
`loadTreeSnapshot` fail open to `null` because they gate a *cache* — the worst
case is running uncached, which is still correct. Here the enumeration is the
input to a *correctness gate*, so a degraded or empty listing would make the
coverage check vacuously pass. `listRepoFiles` therefore throws on a non-zero
exit. This costs nothing in practice: `run()` already `await`s
`getWorktreeRoot()`, which itself throws outside a git repo, so by the time this
runs the process is already committed to being in a repo.

### 2. Threading it through — one `await`, not an async refactor

`run(ctx)` in `type-check/check/index.ts` is already `async` and already awaits
`spawnCaptured` for other things. Every consumer downstream
(`computeClosureFingerprints`, `computeOwnership`, `openProgramKeyContext`,
`programKey`, `recordOuterReadSet`) already takes a `TreeListing` / `ImportGraphs`
**value**, not a root path — so nothing below the top of `run()` changes shape.

- `findLintFiles(root)` → `findLintFiles(files: string[])`; delete
  `walkLintFiles`, `IGNORED_DIR_NAMES`, `isIgnoredRelPath`. It becomes
  `files.filter(isLintable)`.
- `buildImportGraphs(root)` → `buildImportGraphs(root, files: string[])`.
- `readTreeListing(root)` → a zero-I/O projection over the same array; delete
  `walkFiles` and the second `IGNORED_DIR_NAMES`.
- `run()` calls `listRepoFiles(root)` once, at the top, and passes the array to
  both — finally making true the "one reading of the tree" the plugin's
  `CLAUDE.md` already claims.

No raw `Bun.spawnSync`. The repo tolerates sync spawn only at call sites that
are structurally synchronous; this one is not, so a second, weaker spawn path
would buy nothing.

### 3. The compiled-but-gitignored registries

The exception lives in exactly one place — `program-key.ts`, next to
`isTsName` / `allTsNames` — and nowhere else. It must never leak into
`isLintable` (the lint universe correctly excludes `*.generated.ts`) nor into
`listRepoFiles` (which stays a pure git projection).

Derive it rather than declare it. Every such file is a sibling of a **committed**
`<dir>.generated.ts`, so the directories to look in come out of the git listing
itself — no plugin-tree walk, no repo walk:

```ts
// For each directory that holds a committed `*.generated.ts`, list that ONE
// directory (flat, non-recursive) and keep the gitignored per-composition
// registries beside it. The filename spelling is not re-typed here: it is read
// back through the same parser the WRITER uses, so the two cannot drift.
import { parseNamedCompositionRegistryFileName } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
```

`allTsNames` becomes the census over the git listing **plus** that probe's
output, deduped and sorted as today. `checks → codegen` is an established edge
(ten-plus check plugins already import that barrel) with no reverse import, so
it introduces no cycle.

*If* pulling the codegen barrel into this hot, cache-gating check proves too
heavy at implementation time, the fallback is a local
`COMPILED_BUT_GITIGNORED_GLOBS` constant in `program-key.ts`, bound to reality by
a co-located test asserting those two lines still exist in `.gitignore` — rung 3
instead of rung 1. Take the derived version unless the import measurably hurts.

### 4. ESLint's `ignores` stops being an independent list

Split the array into its two genuinely different halves:

- **The directory entries** (`node_modules`, `dist`, `.git`, `.check-*`,
  `.claude/worktrees`, `web-core/dist`) are every one of them a `.gitignore`
  pattern. They stay, but demoted in a comment to what they actually are: a
  convenience for the editor and for a stray `bunx eslint .`. They gate nothing
  — the check feeds `Linter.verify` an explicit file list built by
  `listRepoFiles`, so ESLint's own file discovery never decides the verdict.
  Drift here costs an editor squiggle, not a red check.

  (`@eslint/compat`'s `includeIgnoreFile` would collapse these into `.gitignore`
  outright. It is **not currently a dependency** — noted as an optional
  follow-up, deliberately not adopted here.)

- **The two real lint-scope exceptions** (`**/*.generated.ts`, `prototypes/**`)
  are not about gitignore at all — they are tracked, committed files ESLint
  deliberately skips. These move into one shared
  `lint/core/lint-scope-exceptions.ts` exporting both the glob list and an
  `isLintScopeExcluded(rel)` predicate, re-exported from the `lint/core` barrel.

`build-lint-config.ts` imports it **relatively** (`./lint-scope-exceptions`) —
load-bearing, because that file is dual-loaded under jiti (`eslint.config.ts`,
which cannot resolve `@plugins/*`) and under Bun. `import-graph.ts` consumes it
via the barrel, and `isLintable` shrinks to an extension test plus that
predicate, with no directory logic left in it at all.

This also settles the `prototypes/**` disagreement in ESLint's favour: the
coverage gate now excludes it too, matching what ESLint already did.

A co-located `lint-scope-exceptions.test.ts` binds the two representations —
asserting the predicate agrees with a real glob matcher over the glob list for a
battery of paths — since flat-config `ignores` takes globs and the walk takes a
predicate, and one of the two spellings has to survive.

### 5. Stopping the next copy — `no-adhoc-repo-walk`

New lint plugin at
`plugins/framework/plugins/tooling/plugins/lint/plugins/repo-walk-safety/`,
built on the exact shape of the existing `no-adhoc-git-grep`
(`git-grep-safety`): flag any array/`Set` literal that lists `"node_modules"`
together with `"dist"` or `".git"` — the signature of a hand-written directory
deny-list — outside a small, reviewed allowlist.

The allowlist is the point, not a concession: `web-artifacts/core/internal/own-files.ts`,
`plugin-tree/core/internal/{plugin-tree,fs-snapshot}.ts` and
`program-key.ts`'s `selfSourceHash` are all *bounded* walks over a known subtree
rather than attempts to enumerate the repo's sources, and listing them makes
each a reviewed exemption instead of an invisible fifth copy.

### 6. Where this lands on the fix ladder

Mostly **rung 1, inexpressible**: `IGNORED_DIR_NAMES`, `isIgnoredRelPath`,
`walkLintFiles` and `walkFiles` are *deleted*, not corrected. There is no longer
a directory list to forget to update, because the answer is git's. The
compiled-but-gitignored exception is rung 1 too, if the spelling is read back
through the writer's own parser.

What cannot collapse to a single spelling is pinned at **rung 3**: the
glob-vs-predicate pair by a test, and the whole class by the new lint rule.

## Files

**New**
- `plugins/framework/plugins/tooling/plugins/checks/core/repo-files.ts` (+ barrel export in `checks/core/index.ts`)
- `plugins/framework/plugins/tooling/plugins/lint/core/lint-scope-exceptions.ts` (+ its test, + barrel export)
- `plugins/framework/plugins/tooling/plugins/lint/plugins/repo-walk-safety/` (lint rule + `CLAUDE.md`)

**Modified**
- `.../checks/plugins/type-check/check/import-graph.ts` — delete the walk and the deny-list; `isLintable` becomes extension + shared predicate
- `.../checks/plugins/type-check/check/fingerprint.ts` — delete the second walk; `readTreeListing` becomes a projection
- `.../checks/plugins/type-check/check/index.ts` — one `await listRepoFiles(root)`, passed to both
- `.../checks/plugins/type-check/check/program-key.ts` — `allTsNames` unions the derived registry probe
- `.../lint/core/build-lint-config.ts` — split the `ignores` array; import the shared exceptions
- `.../checks/plugins/type-check/CLAUDE.md` — the "one reading of the tree" section becomes true; say the universe is git's

**Follow-up, not in this change**
- `plugin-boundaries/check/index.ts` carries the same deny-list bug and is also
  `inputKeyed`. It is one `listRepoFiles` call from being fixed, but it is a
  different check with its own cache semantics and deserves its own review.

## Verification

1. `./equin check type-check` before and after — same verdict. The file
   sets are already byte-identical, so any difference is a regression.
2. **The reported bug, as a test.** Drop a `.ts` under `.cache/` and confirm the
   check no longer flags it. Make this permanent as a unit test over
   `listRepoFiles` + `isLintable` rather than a one-off manual check.
3. A tracked file deleted from the worktree but not staged, and the committed
   gitlink, both absent from the listing (the `isFile()` filter).
4. `./equin check plugin-boundaries` — catches the new `checks → codegen`
   edge if the derived probe is taken.
5. Open a `*.generated.ts` and something under `prototypes/` in the editor —
   ESLint still ignores both after the `ignores` split.
6. `./equin test plugins/framework/plugins/tooling/plugins/lint` and
   `./equin test plugins/framework/plugins/tooling/plugins/checks`.
7. `./equin build`, then confirm from the check log that the per-target
   program skip still works (`type-check: skipped N of M targets…`) — the line
   that would expose a weakened program key.

## Separate finding, not part of this change

`.claude/worktrees/claude-1775848273` is committed to the index as a gitlink
(mode 160000) — a nested agent worktree that got committed by accident. It is
why `git submodule status` errors, and why git's listing reports a phantom entry
that the `isFile()` filter has to drop. Removing it from the index is a distinct
change and should be reviewed on its own.
