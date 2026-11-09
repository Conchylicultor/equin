# Repo-wide refactors: an audit of the scripts agents write, and a bounded rename verb

Task: task-1794187184 (responsiveness audit, supervisor task-1793965642-94fdhj,
decision D3). Audit and design only; nothing here is implemented. Follows
[`2026-11-06-global-inventory-script-memory.md`](2026-11-06-global-inventory-script-memory.md)
and [`2026-11-06-global-agent-ops-memory-is-gc-slack.md`](2026-11-06-global-agent-ops-memory-is-gc-slack.md),
which first saw `scratch-rename.ts` at 7.2 GB.

## Summary

- **Only one hand-written refactor script used a type-aware engine**:
  `blocking-fs/scripts/scratch-rename.ts` (2026-11-06), a whole-program
  `ts.createLanguageService` used to rename blocking helpers to `*Sync` (76 in the first pass, then 35, 23 and 8).
  It peaked at 7.2 GB. Its first `--apply` ran for ~54 min, and the agent
  rewrote it three times.
- **The common refactor is a symbol rename done with `rg -l … | xargs sed -i`**:
  27 sessions did this. It is cheap and exact when the name is unique. It is
  wrong for a name like `read` (5,223 files mention it) or for a member.
- **Every other codemod is syntactic and per-file** (`ts.createSourceFile`,
  regex, Python): 13 scripts in 11 sessions. These are cheap (no program), and
  each one carries logic for its own migration: call-shape rewrites, JSX
  restructuring, rewrites driven by a diagnostic or a lint message. They are
  not a memory problem, and a generic CLI would not cover their logic.
- **Recommendation:** `./equin refactor rename`, a type-aware rename over a
  **scoped program**. The sources are only the files that can reference the
  symbol; every other file is served as its stored `.d.ts` through
  type-check's existing `NameHost`. Memory grows with the size of the
  reference set, not with the repo. Custom logic stays in the agent's script,
  but that script only produces a **spec** (rows of what to rename to what).
  The verb emits a JSON **plan** and applies it in one pass. A
  `whole-program-script` guard sends agents to the verb, and so do a CLAUDE.md
  line and the plan skill. `move-export` is phase 2. A pattern-rewrite verb is
  not proposed until call-shape codemods show a cost.

## 1. Audit

### Sources

- **Transcripts:** every `*.jsonl` under `~/.claude/projects/` (1,960 project
  dirs, back to 2026-06-02), subagents included. They were searched for
  `createLanguageService`, `findRenameLocations`, `ts-morph`,
  `scratch-rename`, `createProgram`, `ast-grep` / `jscodeshift`, Write/heredoc
  targets named `*codemod*` / `migrate-*` / `*rename*` / `*rewrite*`, and
  `sed -i` / `perl -pi` over `$(rg -l …)` or `rg -l … | xargs`. Each script
  found was then extracted with its runs and outputs.
- **Scratch dirs:** `/tmp/equin-scratch/*` (27 dirs) holds no refactor script;
  scratch dirs do not outlive their session. Worktree roots (depth 2) hold none
  either.
- **Op log:** `script` ops (`op_log_ops`, `~/.equin/op-log.jsonl`) record no
  script path, so they cannot be attributed. Peaks come from `health-owners`
  samples (the 2026-11-06 docs) and from the `time -l` lines in transcripts.
- **Research docs:** the codemods planned in
  [`fold-uselive-row`](2026-10-27-global-fold-uselive-row-into-uselive.md),
  [`data-view-field-roles`](2026-10-26-global-data-view-field-roles.md) §3,
  [`material-symbols-icons`](2026-09-27-global-material-symbols-icons.md) §2,
  [`zod-4-migration`](2026-10-28-global-zod-4-migration.md) (ast-grep),
  [`ui-kit-extraction`](2026-06-11-global-ui-kit-extraction.md) step 7, and
  [`derived-slot-ids`](2026-08-18-global-derived-slot-ids.md).

No transcript in the corpus uses `ts-morph`, `jscodeshift` or an installed
`ast-grep` (`sg` is not installed).

### A. The type-aware rename (the 7.2 GB case)

`plugins/infra/plugins/host-fs/plugins/blocking-fs/scripts/scratch-rename.ts`,
conv-1793983996-sesm31, 2026-11-06 (landed as `ba3124522c`, 362 files).

- **What it did:** renamed each blocking helper that a backend can reach to
  `<name>Sync`, everywhere it is referenced. The input was a TSV of
  `file\tline\towner`, built from the `blocking-fs/sync-named` lint findings
  of a separate scratch inventory (`scratch-inventory.ts`, whole-program typed
  ESLint, 5.3 GB). It was filtered to the files a backend reaches (a 5,449-module
  BFS).
- **Engine:** `ts.createLanguageService` over the root tsconfig's
  `cfg.fileNames` (~15k files). For each row it found the declaring identifier
  at or above the line, called `findRenameLocations`, and spliced the edits
  back-to-front.
- **Custom logic, in the order it was added:**
  1. Finding the declaration: an identifier named `owner` at or above the
     line, whose parent is a function / method / variable / property
     declaration. `??` rows were reported when none was found.
  2. `providePrefixAndSuffixTextForRename` switched from `true` to `false`.
     With `true`, the language service keeps old names alive through aliases
     (`import { readSync as read }`, `{ read: readSync }`). The agent grepped
     the diff for `\w+Sync as ` to find them.
  3. Collect all locations first, then apply once, de-duplicating spans. The
     first version wrote each row's edits and bumped the file's version, so
     the language service rebuilt its program for every following row: the
     first `--apply` ran 17:23 → ~18:17 (~54 min). The collect-then-apply
     version ran in 4 min 09 s (70 user-s).
  4. Skip `async` owners (not blocking; a lint false positive) and skip a
     name collision (`<owner>Sync` already in the file: `readTail`,
     `readJsonlTail`).
  5. A denylist of rows the agent judged wrong (`/guards/`, `ensure`,
     `pruneRuns`, …).
  6. Loop to a fixpoint (`/tmp/iterate.sh`): inventory → reached rows →
     rename, because each rename makes its callers blocking-named in turn
     (the rule works by induction). There were three iterations of about
     4 min each: 35, 23 and 8 renames.
- **Cost:** 7.2 GB peak (17:21 sample); the dry run took ~10 min, apply v1 ~54
  min, then v2 4 min plus 3 × ~4 min. Counting the inventory runs, a
  whole-repo program was built about 9 times.
- **Worked?** Yes. After the passes, the type check flagged 1 straggler
  (`readJsonlTail` → `readJsonlTailSync` on `FileSink`, a member access).

### B. Text renames over `rg -l` (27 sessions)

Examples: `saveClaudeAccountToken` → `saveClaudeAccountCredential`;
`MergedDataView*` → `DataViewSwitcher*`; `focusedTabSet` →
`peekFocusedTabSet`; `conversationPane.useRouteEntry()` → `.useEnclosing()`;
`interactiveMandate()` → `interactiveMandate`; the import specifier
`@plugins/apps/plugins/desktop/(web|core|server)` → `…/desktop/plugins/windows/…`;
check / lint ids (`no-hook-sink-register`, `server-core:boot-closure-…`);
the product rename (`./singularity` → `./equin`, `@singularity/` → `@equin/`);
and a reverse loop, `perl -pi -e 's/\b${n}Sync\b/${n}/g'`.

- **Engine:** `rg -lw` + `sed -i` / `perl -pi`, at a cost of milliseconds and
  MB.
- **Custom logic:** none beyond the regex; sometimes an exclusion
  (`grep -v mandate-presets/core`).
- **Worked?** This is exact when the old name is unique in the repo, which it
  was in every example above. The outcome of each session was not audited.
  The method breaks for a common name (`read`), a member, a shadowed local, or
  a re-export alias, and nothing tells the agent which case it is in. That is
  exactly why the `*Sync` agent reached for the language service.
- String identities (check ids, rule ids, config keys, task ids) are
  free-text renames that checks validate. They are not symbol renames, and a
  rename verb should not take them over.

### C. Syntactic codemods (13 scripts, 11 sessions)

| when | script | operation | engine | custom logic |
| --- | --- | --- | --- | --- |
| 10-17 | `.codemod2-tmp.ts` | `<WithTooltip content><Button/></WithTooltip>` → `<Button tooltip>` | `createSourceFile`, per file | only for 4 target tags with only `content`/`side`; SKIP report |
| 10-17 | `rewrite_visible_fields.py` | config JSONC `visibleFields: [ids]` → `properties: [{id}]` | regex | data, not code |
| 10-22 | `addarg.py` | append an argument to every `new X(` / `X(` call | balanced-paren scan | multi-line indentation |
| 10-26 | `root-migration/cli/rewrite.ts` | stored-path rewrite (committed, a real CLI) | regex | shared with the leftover scan |
| 10-28 | `.migrate/codemod.ts` | `useLiveRow(a, b)` → `useLive(a, { id: b })` + import fix (113 calls, 88 files) | `createSourceFile` | throws on a bad shape, keeps import order and multi-line form |
| 10-30 | `codemod.ts` (user-path) | wrap `asUserPath(…)` at each TS2345 `string` → `UserPath` + add the import | `createProgram` over 5 dirs | driven by a diagnostic code and message |
| 10-31 | `fold-codemod/codemod.py` | `useLiveRow` again (a second branch) | paren/quote scan | — |
| 11-02 | `tmp-scan/codemod.ts` | `vi.mock` factory → `async (importOriginal) => ({ ...await importOriginal(), … })` | ESLint `Linter.verify` with the repo rule | the fix is at the rule's own message ranges; MANUAL list |
| 11-04 | `/tmp/rr/codemod.ts` | move `REPO_ROOT` imports from `paths/{core,server}` to `paths/plugins/repo-root/core` (67 files) | regex on import decls | resolves relative specifiers, splits the import |
| 11-08 | `rename-pool.ts` etc. | small in-place Python edits | string replace | — |

Planned in docs, same shape: `primary: true` → `role: "title"` (~106 files),
`Md*` → `symbol("…")` (630 files, name table), `TruncatingText` → `Text`
(~95 sites), stripping `id:` from barrels, and `ZodParser<T>` →
`z.ZodType<T>` (105 sites, ast-grep).

- **Cost:** none of these builds a whole program except the user-path
  codemod. That one is rooted at 5 dirs, but a program still loads the import
  closure of its roots (the 2026-11-06 finding: rooting at a subset does not
  shrink a program much). Its cost was not measured.
- **Worked?** Yes, each with a hand pass over its SKIP / MANUAL list.

## 2. Classification

| operation | seen | generic? | memory today |
| --- | --- | --- | --- |
| **rename a symbol** (export, local, member) | 27 sed sessions + the LS script | **yes** — the target set and new names vary, the mechanics do not | sed: none. LS: 7.2 GB |
| **move an export to another module** (re-point named imports, split decls) | REPO_ROOT, desktop barrels, ui-kit plan, `resolveRepoModule` move | **yes** | regex, none |
| **move / rename a plugin** | — | done: `./equin plugin move` | syntactic |
| **call-shape rewrite** (args → options object, drop a call, JSX restructure) | useLiveRow ×2, addarg, mandates, WithTooltip, icons, field roles | the *kind* recurs, each *pattern* is a one-off | per-file AST, ~none |
| **diagnostic-driven fix** (apply X at each tsc / lint finding) | asUserPath, vitest mocks | recurs, but the fix belongs to the rule (an ESLint `fix`) or is one-off | program-sized for tsc-driven ones |
| **config / data rewrite** | visibleFields | one-off; `defineConfigMigration` exists | none |
| **choosing the targets** (what to rename) | `*Sync` (from lint + reach) | **one-off by nature** — this is the custom logic | inventory: 5.3 GB (a separate class; see the inventory doc) |

Only the rename is both generic and expensive when done right. The custom
logic the user expected lives in **choosing the targets**, in **domain
filters** (skip async, a denylist) and in **looping to a fixpoint**, not in
the rename mechanics. The rename mechanics are what every agent re-derives
and gets wrong: alias prefixes, per-row reprogramming, overlapping spans and
collisions.

## 3. Design

### Options for the rename engine

**0. Docs + guard only.** Point agents to `rg | sed` for unique names, and say
"run a whole-program script heap-paced". This costs almost nothing. It leaves
non-unique names and members with no tool, so the next `*Sync`-style
migration writes the same script.

**1. Syntactic, scope-aware rename.** Bind each candidate file on its own (a
one-file program, `noResolve`): `findRenameLocations` on an import binding
gives every use in that file, shadowing included. Cross-file links come from
the import graph (`resolveRepoModule`, re-exports, `export *`,
`import * as ns` member access, `vi.mock` factories). Memory is O(one file).
It **cannot rename members** (`x.read()` needs the type of `x`), and members
were exactly the hard rows of the `*Sync` case (`DiskRead.read`,
`FileSink.readJsonlTail`).

**2. Type-aware rename over a scoped program (recommended).** This is the
same `findRenameLocations`, but in a program whose **sources are only the
candidate files**. Every other repo file is served as its stored `.d.ts`,
exactly the way type-check's program 1 serves them (`shared/name-host.ts`
`createNameHost({ sources, contractOf })`).

- **Candidate set (sound superset):** files whose source **or stored
  contract** spells the identifier (`rg -lw` over the tree, plus the contract
  store), closed over aliases: a candidate that re-exports or destructures
  under another name adds that name and loops. A file that mentions neither
  can hold no reference: in a program that serves it as `.d.ts`, any type of
  its own that carries the member would appear in its contract text. The
  contract half is what makes inferred types safe, for example
  `export const disk = makeDisk()` printing `{ read(): … }` inline.
- **Narrowing for a common name:** intersect the candidates with the
  reverse import closure of the declaring file and of the contract-mentioning
  files. A file cannot reach a member of a type it cannot see. Measured: the
  renamed names were in 3–30 files (`openOwnedFd` 29 files / 68 refs); `read`
  appears in 5,223 files, but its declaring file's reverse closure is a small
  fraction of that.
- **Memory bound:** ≤ `TYPE_CHECK_LIGHT_SOURCES` (100) sources is the light
  path, where type-check runs measure a ~1.1 GB median peak. A larger set is
  split into dependency-ordered batches of ≤ `TYPE_CHECK_BATCH_FILES`, one
  fresh process per batch, heap-paced. This is `batch-run.ts`, reused
  (batch peaks of 5.3 GB on the heavy end). It runs under the same host-pool
  slot as a type-check run (`type-check-light` / `type-check-worker`), so it
  is admitted, unlike a script.
- **Correctness:** the rename semantics are TypeScript's own. Contracts must
  be fresh, so the verb first runs the type-check contract pass for the tree
  (warm: seconds; it is what `./equin check type-check` keeps warm anyway).
  After applying, it runs `type-check` incrementally, so a missed reference
  fails loudly, the way `plugin move` defers to `./equin check`.
- **Cost:** type-check would have to publish the scoped-host construction
  from its `core` barrel (`shared/` is plugin-private, R10). This adds a
  second consumer to a load-bearing engine.

**3. Diagnostic-driven loop.** Rename the declaration, run type-check, and
apply TypeScript's "Did you mean '<new>'?" suggestions (TS2551 / 2552 / 2724,
and 2353 for object-literal keys) wherever the suggestion is the new name.
Repeat until clean. This reuses everything as-is, but it needs a clean tree to
start from. It cannot tell a shorthand `{ read }` (which needs
`{ readSync: read }` or a local rename) from a real error. It makes N full
incremental runs. Keep it as the **verification step** of option 2, not as
the engine.

**4. A language service at the batch level** (the 2026-11-06 triage's
"batched type-aware rename"). This runs `findRenameLocations` in each
type-check batch of the whole tree. It is correct, but it costs a whole-tree
batched run for every rename (~450 worker CPU-s cold) where option 2 pays for
the candidate set. Option 2 falls back to this only when the narrowed set is
itself the whole tree.

### The verb

`./equin refactor rename`, in a new group. `plugin move` stays where it is.
It moves plugins, which is not a symbol operation, but both share the edit
engine (below).

```
./equin refactor rename <file>:<line|name> <newName>      # one symbol
./equin refactor rename --spec rows.jsonl                  # many: {file, line?, name, to}
          [--dry-run] [--json plan.json] [--apply-plan plan.json] [--prose rewrite|review]
```

- **Plan, then apply** (the relocate split: `cli/internal/plan.ts` pure and
  tested). The plan holds every location from every row, de-duplicated,
  before anything is written: one program build, no per-row reprogramming.
  Edits apply back-to-front per file, and an overlapping range or a range
  that no longer holds its text throws. That is relocate's applier, lifted to
  a shared `core` and used by both.
- **Refusals are rows, not silence.** Each row is `renamed` | `refused` with
  a reason. The built-in reasons are the generic ones the `*Sync` script had
  to invent: `no-declaration` (nothing at that line), `collision` (the new
  name is already bound in a scope a location sits in, or exported by a
  barrel it would join), `ambiguous` (several declarations match),
  `outside-repo` (a node_modules / lib symbol) and `generated` (a
  `*.generated.ts` declaration: rename its source).
- **No alias prefixes**: `providePrefixAndSuffixTextForRename: false`, always.
  A shorthand property or binding is expanded deliberately
  (`{ read }` → `{ readSync }` when the local is the same symbol, and listed
  otherwise).
- **Prose:** comments and JSDoc come from `findInComments`. Markdown mentions
  are found with relocate's mention model (`` `oldName` `` in `*.md` and
  CLAUDE.md, outside AUTOGENERATED blocks). They are listed for review by
  default (`--prose rewrite` rewrites them). `research/` is never rewritten.

### Where custom logic plugs in

The custom logic was always about **which** symbols and **what new name**,
plus filters and a fixpoint loop. The verb takes that as data and keeps the
mechanics:

1. **Spec in.** The agent's script (cheap: lint output, `rg`, a TSV) writes
   rows `{file, line?, name, to}`. `to` is a literal. The script computes it
   (`name + "Sync"`).
2. **Plan out.** `--dry-run --json plan.json` gives each row's locations,
   files and refusals. A domain filter ("skip async owners", a denylist) is a
   filter over the spec or the plan, written by the agent in a few lines and
   holding no program.
3. **Apply the plan as reviewed**: `--apply-plan plan.json`, refused if any
   file changed since the plan was made. The plan records each file's hash.
4. **Fixpoint:** the agent's loop re-runs its target query and the verb. Each
   pass costs the candidate set, not the repo.

There is no plugin slot or hook API. An in-process API (a script importing
`planRename`) would put the program back in the script's unadmitted process,
which is the cost this removes. The spec/plan JSON is the extension surface.
Call-shape codemods stay scripts: they are per-file and cheap, and their
logic is the whole point.

### Phase 2: `refactor move-export`

`./equin refactor move-export <name> --from <module> --to <module>`
re-points every named import of `name` from `from`'s barrel to `to`'s,
splitting import declarations and merging with an existing import of `to`.
It refuses when the move breaks the boundary table (it runs the
`boundary-rules` evaluation on the new edges) and when `to` does not export
the name. This covers REPO_ROOT, the desktop barrels and ui-kit step 7. The
candidate set is syntactic (importers of `from`), so no program is needed;
the check runs after.

### Not proposed: a pattern-rewrite verb

An `ast-grep`-style `./equin refactor rewrite --pattern 'useLiveRow($A, $B)'
--to 'useLive($A, { id: $B })'` would cover 2 of the 13 scripts as written.
The others needed conditions (only some tags, a throw on an unexpected
shape), an import fix, or a SKIP list. These scripts cost nothing in memory.
Adding a native dependency for them is not justified today. Revisit it if the
audit is repeated and call-shape scripts are failing, not just being written.

### How memory stays bounded, in one place

| path | what holds memory | bound |
| --- | --- | --- |
| ≤ 100 candidate sources | one program: sources + served `.d.ts` | the light-pool run (~1.1 GB median) |
| > 100 | dependency-ordered batches, one process each, heap-paced | `TYPE_CHECK_BATCH_FILES` per process; serial |
| admission | a `type-check-light` / `type-check-worker` pool slot | the host's existing grant |
| text, prose, move-export | `rg` + per-file parse | O(file) |

### Discovery

The 2026-11-06 triage found the gap. The `*Sync` agent never looked for a
tool because none was named anywhere, so all four of these are needed:

1. **Root `CLAUDE.md`**, CLI section, one line: "Rename a symbol across the
   repo: `./equin refactor rename` (type-aware, bounded; `--spec` for many).
   Never build a whole-repo TypeScript program in a script."
2. **Guard `whole-program-script`** (Write / Edit / Bash heredoc, and
   `./equin run <file>` by reading the file): it denies once (`allowOnRepeat`,
   since the concern is cost) a `.ts` holding `createLanguageService(` or
   `createProgram(` fed the root tsconfig's `fileNames`
   (`getParsedCommandLineOfConfigFile` + `tsconfig.json`). The denial names
   `./equin refactor rename` for renames, `./equin check type-check` /
   `eslint` for inventories, and says a one-off codemod should parse per file
   (`createSourceFile`). Before landing, replay it with
   `guards/e2e/replay-transcripts.ts`: over this corpus it should fire on
   `scratch-rename.ts`, `scratch-inventory.ts` and the user-path codemod, and
   on nothing in the type-check plugin's own `shared/` (a committed engine,
   out of scope by folder).
3. **An inform, once per session**, on `rg -l … | xargs sed -i 's/\bX\b/Y/'`
   when `X` is an identifier spelled in ≥ 50 files: "a common name — `./equin
   refactor rename` resolves it by symbol". It never fires for a unique name,
   where sed is right.
4. **The `plan` skill**, under migrations: "a rename step is `./equin refactor
   rename --spec`; a codemod step parses per file". This is where the
   `useLiveRow` and field-roles plans wrote "TS compiler API via
   `./equin run`".

### What it replaces

- whole-program language-service scripts (`scratch-rename.ts`: 7.2 GB, ~54
  min on its first apply, 3 rewrites of the mechanics);
- sed renames of non-unique names and members (the case sed cannot do);
- the ad-hoc edit applier each codemod re-writes (relocate's applier becomes
  shared);
- import-repointing regexes (phase 2).

It does not replace sed for unique names or string ids, per-file call-shape
codemods, or the target-choosing inventory. The inventory is the other half
of the `*Sync` cost (5.3 GB). Its sanctioned path is reading a check's own
findings, which is the inventory doc's subject, not this one.

## 4. Recommendation and open points

Build option 2 as `./equin refactor rename`, with option 3 as its
post-apply verification, the spec/plan protocol for custom logic, and all
four discovery items. Build `move-export` second. Do not build a pattern
rewrite.

For the user to decide:

- **Where it lives.** Proposal: `plugins/framework/plugins/tooling/plugins/refactor/`
  (`cli/` for the verb, `core/` for the plan types and the shared edit
  applier, which relocate then imports). type-check publishes the
  scoped-host constructor from its `core`. The alternative is to nest it
  under `plugin-meta/relocate`, but that plugin is about plugins.
- **Contract freshness.** Either run the contract pass inside the verb
  (simplest, and may cost a batched run after a global change), or refuse
  when contracts are stale and tell the agent to run `./equin check
  type-check`. Proposal: run it inside, under the same grant.
- **Before building:** prototype option 2's candidate rule on the `*Sync`
  spec (the first pass's 76 rows) against a full-program rename. The two location sets must
  be equal, and the peak must be measured. That comparison is the acceptance
  test.
