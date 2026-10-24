# Pane segment collisions: closing the untracked-file gap in the static check

## Context

Registering two panes with the same URL segment (e.g. a new pane using
`segment: "agents"` while `conversations/agents` already owns it) crashes
`core.root` at runtime — `useSyncPaneRegistry()` throws *"Pane segment
collision"* on every render, so every route paints blank. Segment uniqueness is
a **global, cross-plugin** invariant because URL matching walks a flat,
unordered `Map` of all registered panes; two segments that normalize to the same
pattern make matching ambiguous.

A static check for this **already exists** — `pane:segments-unique`
(`plugins/primitives/plugins/pane/check/index.ts`, added in commit
`dabb3b78a`). It AST-parses every `Pane.define(...)` / `defineRoute(...)` call,
extracts the literal `segment`, normalizes it with the **shared**
`normalizeSegmentPattern` (`plugins/primitives/plugins/pane/core/route.ts`, the
same function the runtime uses — so they can't drift), and fails the build on
any pattern owned by >1 site.

**So why does the crash still reach runtime?** The check hand-rolls its file
discovery with a bare `git grep -l` (`candidateFiles`, lines 25–40):

```ts
const out = await git(root, ["grep", "-l", "-e", "Pane.define", "-e", "defineRoute", "--", "plugins/**/*.ts", ...]);
```

`git grep` only searches **tracked** files. The file that introduces a collision
is a **newly-created, still-untracked** pane file — precisely what an agent
produces when adding a pane. The agent's normal loop is *edit → `./equin
build` (which runs checks) → deploy → browser*; the new file is never committed
before deploy, so `git grep` can't see it, the check passes, the app ships, and
`core.root` crashes at runtime. (Editing an *existing* tracked file to add a
duplicate **is** caught — `git grep` sees tracked files' working-tree content.
Only brand-new files slip through, which is why the crash looks like "no check
fires".)

This is a footgun the checks infrastructure already solved and documents against
— `plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md` mandates using
`grepCode` (from `checks/core`) instead of a bare `git grep`. The sanctioned
scanner's shared file-discovery helper, `readCandidates`
(`checks/core/grep-code.ts:123`), is both **scan-tree-aware** and
**untracked-aware**:

- Under a cached run the runner wraps each check in `withScanTree(treeHash, …)`
  (`runner.ts:98`). `treeHash` comes from `computeTreeHash`, which does `git add
  -A` into a throwaway index (`tree-hash.ts:49`) — so **untracked files are in
  the hashed tree**. `readCandidates` then greps that tree and reads blobs via
  `git cat-file --batch`, seeing the untracked file.
- Under an ad-hoc / `--noCache` run (`currentScanTree()` is null) it falls back
  to the working tree and adds `--untracked` (`grep-code.ts:158`).

The pane check bypasses all of this, so it is blind to untracked files **and**
its cached PASS is keyed on a tree hash that *did* include the missed file — the
pass is recorded against content the check never actually inspected.

**Intended outcome:** the collision is caught at `./equin build` (before
deploy) for new *and* modified files, the class of "check hand-rolls a
git-state-dependent `git grep`" is structurally prevented from recurring, and
runtime/build-time detection stay single-sourced.

## Approach (route through the sanctioned scanner)

Three changes.

### 1. Expose a scan-tree/untracked-aware candidate-source lister from `checks/core`

`readCandidates(root, grepArg, fixed, pathspecs) → Array<{ rel, src }>`
(`plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts:123`) is
exactly what an **AST-based** check needs (candidate paths + their source), and
it already gets the git plumbing right in every mode. Today it's a private
helper shared only by `grepCode`/`grepImports`. Promote it to a public export so
AST checks have a sanctioned home too (the checks doc currently only points
line-oriented checks at `grepCode`, which is why the pane check hand-rolled its
own and got it wrong).

- Add a public wrapper `listCandidateSources(opts: { root?; grepArg; fixed?;
  pathspecs? }) → Promise<Array<{ rel: string; src: string }>>` in
  `grep-code.ts` (thin pass-through to `readCandidates`; default `root` to the
  repo top-level so callers needn't spawn `git rev-parse` themselves).
- Re-export it and its return type from
  `plugins/framework/plugins/tooling/plugins/checks/core/index.ts`.
- Extend `checks/CLAUDE.md`: "AST-based checks (that parse candidate files
  rather than regex-scan lines) MUST get their candidate sources from
  `listCandidateSources`, never a bare `git grep` — it is scan-tree-aware and
  sees untracked files; a bare `git grep` misses not-yet-committed files."

### 2. Migrate `pane:segments-unique` onto it

File: `plugins/primitives/plugins/pane/check/index.ts`.

- Delete the local `git`, `getRoot`, `candidateFiles` helpers and the
  `Bun.file(...)` read (lines 7–40, 117).
- `import { listCandidateSources } from
  "@plugins/framework/plugins/tooling/plugins/checks/core"` and (optionally)
  replace the drift-prone inline `Check`/`CheckResult` copies with the real
  types from `@plugins/framework/plugins/tooling/core`. This cross-plugin barrel
  import is already an established pattern for checks living outside the checks
  tree (e.g. `plugins/infra/plugins/endpoints/check/`,
  `plugins/apps-core/plugins/app-icon/check/`), and adds no cycle (`checks/core`
  does not import `pane`).
- In `run()`, replace the grep+read with:

  ```ts
  const sources = await listCandidateSources({
    grepArg: "Pane\\.define|defineRoute",   // fixed:false → git grep -E
    pathspecs: ["plugins/**/*.ts", "plugins/**/*.tsx",
                ":(exclude)**/*.test.ts", ":(exclude)**/*.test.tsx"],
  });
  for (const { rel, src } of sources) {
    for (const site of collectSegments(rel, src)) { /* unchanged */ }
  }
  ```

- `collectSegments`, `isSegmentDefiningCall`, `literalText`, and the
  `normalizeSegmentPattern` bucketing/reporting stay **byte-for-byte unchanged**
  — only file discovery changes.

**Known, accepted limitation (unchanged):** non-literal `segment:` values (a
`const`/interpolated string) are still silently skipped, with the runtime check
as backstop — same as today. Out of scope; noted so it isn't mistaken for a
regression.

### 3. Guard against recurrence — `no-adhoc-git-grep` lint rule

Mirror the existing `import-scan-safety` / `marker-scan-safety` precedent so no
future check re-hand-rolls a git-state-dependent scanner.

- New lint plugin
  `plugins/framework/plugins/tooling/plugins/lint/plugins/git-grep-safety/`:
  - `lint/no-adhoc-git-grep.ts` — flags a `Bun.spawn`/`spawnSync` whose argv
    array literal begins `["git", "grep", …]` (and a string literal containing
    `git grep`), with a message steering to `grepCode` /
    `listCandidateSources`.
  - `lint/index.ts` — `export default { name: "git-grep-safety", rules: {
    "no-adhoc-git-grep": rule }, ignores: { "no-adhoc-git-grep":
    ["plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts"] } }`
    — `grep-code.ts` is the one sanctioned home.
  - `lint/no-adhoc-git-grep.test.ts` — a `RuleTester` valid/invalid pair.
  - `CLAUDE.md` — one-paragraph "why", matching the sibling lint plugins.
- The root `eslint.config.ts` auto-discovers every `lint/index.ts`, so no
  registry edit; `./equin build` regenerates and the `eslint` /
  `type-check` checks enforce it repo-wide.

## Critical files

| File | Change |
|------|--------|
| `plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts` | Add `listCandidateSources` wrapper over `readCandidates` |
| `plugins/framework/plugins/tooling/plugins/checks/core/index.ts` | Export `listCandidateSources` + return type |
| `plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md` | Document the AST-check discovery rule |
| `plugins/primitives/plugins/pane/check/index.ts` | Discover candidates via `listCandidateSources`; drop bare `git grep` |
| `plugins/framework/plugins/tooling/plugins/lint/plugins/git-grep-safety/**` | New `no-adhoc-git-grep` lint rule + test + CLAUDE.md |

## Reuse (do not reinvent)

- `readCandidates` / `grepCode` scan-tree + `--untracked` plumbing —
  `checks/core/grep-code.ts` (the whole point of the fix).
- `normalizeSegmentPattern` — `pane/core/route.ts`; the single shared runtime +
  build-time normalizer. Untouched.
- `import-scan-safety` lint plugin shape — `.../lint/plugins/import-scan-safety/`
  (rule + `ignores` allowlist + CLAUDE.md) as the template for the new guard.

## Verification (end-to-end)

1. **Build & regen:** `./equin build` — regenerates the lint config to
   include `no-adhoc-git-grep`, then runs all checks; must stay green.
2. **Reproduce the exact gap is now closed** (the core proof):
   - Create a **new, uncommitted** file, e.g.
     `plugins/apps/plugins/agent-manager/plugins/shell/web/__probe_panes.tsx`,
     containing `Pane.define({ id: "probe", segment: "agents", component: … })`
     (collides with `agentsRootPane`'s `"agents"`). Do **not** `git add` it.
   - `./equin check pane:segments-unique` → **must now FAIL**, reporting
     both `"agents"` sites. (Sanity: `git stash -u` is not needed; confirm that
     reverting change #2 makes the same probe **pass**, proving the untracked
     blindness was the gap.)
   - Delete the probe file.
3. **No false positives:** on the clean tree, `./equin check
   pane:segments-unique` passes (segments are currently unique).
4. **Guard fires:** temporarily add a `Bun.spawn(["git","grep",…])` inside any
   `check/index.ts` → `./equin check eslint` (or `type-check`) reports
   `no-adhoc-git-grep`; revert. The committed `RuleTester` test also covers this
   (`bun test .../git-grep-safety/lint/no-adhoc-git-grep.test.ts`).
5. **Full sweep:** `./equin check` all-green.
