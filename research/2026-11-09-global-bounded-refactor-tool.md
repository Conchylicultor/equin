# Repo-wide refactors: an audit of the scripts agents write, and a bounded rename verb

Task: task-1794187184 (responsiveness audit, supervisor task-1793965642-94fdhj,
decision D3). Audit and design only; nothing here is implemented. Follows
[`2026-11-06-global-inventory-script-memory.md`](2026-11-06-global-inventory-script-memory.md)
and [`2026-11-06-global-agent-ops-memory-is-gc-slack.md`](2026-11-06-global-agent-ops-memory-is-gc-slack.md),
which first saw `scratch-rename.ts` at 7.2 GB. D3 and D11 are the supervisor
task's decision log entries: D3 asked for this audit, and D11 asked for the
worked examples in §4.

**Terms.** A *language service* / *program* is TypeScript's in-memory model
of a set of files: parsed, bound and type-checked on demand.
`findRenameLocations` is its rename query. A *contract* is a file's `.d.ts`:
its exported types without bodies. `./equin check type-check` stores one per
file, and its *program 1* loads the files it checks as source and every other
file as its stored contract (`NameHost`, `shared/name-host.ts`), which is what
keeps it small. *Heap-paced* means run with `BUN_JSC_forceRAMSize` = 4 GB
(`packages/heap-pacing`), so bun's JavaScriptCore collects as if the machine
had 4 GB instead of 64. Since 2026-11-08 `./equin run` and type-check
batches run this way. *Pool slots* (`type-check-light`, `type-check-worker`)
are the host-wide admission pools a type-check run waits in. A scratch script
takes no slot.

## Summary

- **Only one hand-written refactor script used a type-aware engine**:
  `blocking-fs/scripts/scratch-rename.ts` (2026-11-06), a whole-program
  `ts.createLanguageService` used to rename blocking helpers to `*Sync` (76 in the first pass, then 35, 23 and 8).
  It peaked at 7.2 GB. Its first `--apply` ran for ~54 min, and the agent
  rewrote it three times.
- **The common refactor is a symbol rename done with `rg -l … | xargs sed -i`**:
  27 sessions did this. It is cheap and exact when the name is unique. It is
  wrong for a name like `read` (5,175 `.ts` files mentioned it at the time) or for a member.
- **Every other codemod is syntactic and per-file** (`ts.createSourceFile`,
  regex, Python): 13 scripts in 11 sessions. These are cheap (no program), and
  each one carries logic for its own migration: call-shape rewrites, JSX
  restructuring, rewrites driven by a diagnostic or a lint message. They are
  not a memory problem, and a generic CLI would not cover their logic.
- **Recommendation:** `./equin refactor rename`, a type-aware rename over a
  **scoped program**. The sources are only the files that can reference the
  symbol; every other file is served as its stored `.d.ts` through
  type-check's existing `NameHost`. Memory grows with the size of the
  candidate set and the contracts it imports, not with the repo. Custom logic stays in the agent's script,
  but that script only produces a **spec** (rows of what to rename to what).
  The verb emits a JSON **plan** and applies it in one pass. A
  `whole-program-script` guard sends agents to the verb, and so do a CLAUDE.md
  line and the plan skill. `move-export` is phase 2. A pattern-rewrite verb is
  not proposed until call-shape codemods show a cost.
- **Measured (§4, 2026-11-09, this tree):** a scoped program found the same
  rename locations as the whole program on all 6 rows tried. It took
  0.42–1.17 GB and 7–24 s for 8–277 candidate files, and 1.96 GB / 22 s for a
  member named `read` narrowed to 1,462 files. The whole-program language
  service took 4.0 GB / 30 s heap-paced (5 rows) and 5.3 GB / 60 s unpaced
  (6 rows). That is 3.4–9.5× more memory than scoped for names in at most
  300 files, 2× more than the narrowed `read`, and 1.2× more than `read`
  unnarrowed (3.3 GB). The original's ~54 min apply is consistent with its
  rebuilding the program after each row (not replayed; once built, a row
  costs about 0.2–3 s, up to 11 s for `read`). Its 7.2 GB peak
  and 10-minute dry run were **not reproduced**: the 7.2 GB sample fell in
  the dry run, before any rebuild, and the replay measured 5.3 GB unpaced.
  A careful whole-program script written today would cost ~4 GB and about a
  minute, but no agent wrote one. The verb removes the need to, and its
  scoped engine is the lighter one.
- **The worked examples (§4) changed the API:**
  - A row names its symbol by a position *of* it (`at`), or by a position
    *inside* it plus its name (`in` + `name`: the innermost enclosing
    declaration with that name). A lint finding reports the blocking call,
    not the owner, so `in` is what the `*Sync` case needs.
  - A plan builds **one** program: scoped when the candidate union is small,
    the whole program otherwise.
  - Plan rows carry declaration facts (kind, container, `async`, reach), so a
    domain filter is a `jq` line and a runaway cascade shows up before it is
    applied.

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
the product rename (the old CLI name and package scope → `./equin`, `@equin/`);
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
  files. A file cannot reach a member of a type it cannot see. Measured on the
  `*Sync` commit's 93 renamed names (at `ba3124522c^`): 85 are mentioned in
  ≤ 100 files (median 3; median 4 over all 93), and those 85 have a union of
  239 files. 8 are common words
  (`read` 5,175, `exists` 1,408, `resolve` 1,356, `f` 921, `spawn` 643, `scan`
  442, `flush` 419, `append` 274). For a member `read` declared in a widely
  imported module (`sleep-clock`, a reverse closure of 3,181 files),
  narrowing cuts 5,232 candidates to 1,462 (§4, measured), a 3.6× cut, not
  the order of magnitude hoped for.
- **One program per plan, chosen by size** (changed by §4's measurements).
  The union of all rows' candidates decides: up to `L` sources it is the
  scoped program, and above that it is **one** whole program, heap-paced
  (4.0 GB measured). `L` = 1,500 is a placeholder, not a measured crossover.
  It sits just above the largest scoped program measured (1,462 sources:
  1.96 GB, 22 s, against 4.0 GB / 30 s whole). The only larger point is
  5,232 sources (3.3 GB, 82 s, slower than whole), so the crossover lies
  between them and is not located. Memory follows the program's files, not
  only its sources: contracts come in with every import, so 8 sources
  already loaded 913 files and 1,462 loaded 11,461. Both engines run in a
  type-check pool slot (`type-check-light` for scoped, `type-check-worker`
  for whole), so they are admitted, unlike a script. There is never a
  program per row: one costs 7–24 s however few its rows, against about
  0.2–3 s per row (11 s for `read`) once a program is built.
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
./equin refactor rename <file>:<line>:<col> <newName>       # one symbol, any occurrence of it
./equin refactor rename --spec rows.jsonl --plan plan.json  # many: plan only, writes nothing
./equin refactor rename --apply plan.json                   # apply a plan as reviewed
          [--prose review|rewrite]
```

A **spec row** names its symbol in one of two ways:

- `{ "at": "file:line:col", "expect"?: "oldName", "to": "newName" }`: a
  position of the symbol itself, the declaration or any reference (the
  language service resolves either). `expect` refuses the row when `at`
  holds a different name.
- `{ "in": "file:line:col", "name": "oldName", "to": "newName" }`: the
  innermost declaration named `name` that encloses the position (a function,
  method, property or variable). This is what a finding reported *inside*
  the symbol gives: `blocking-fs/sync-named` reports the blocking call, not
  the owner (`context.report({ node })` on the call, `lint/sync-named.ts`).
  It is the original script's "nearest identifier at or above the line",
  made exact by containment.

A **plan** is one JSON document:

```jsonc
{ "engine": "scoped" | "whole", "sources": 239, "tree": "<git tree>", "files": { "<path>": "<sha256>" },
  "rows": [
    { "at": "…/owned-fd.ts:84:17", "from": "openOwnedFd", "to": "openOwnedFdSync",
      "status": "rename",
      "decl": { "kind": "function", "container": null, "exported": true, "async": false },
      "reach": { "locations": 5, "files": 3 },
      "locations": [{ "file": "…", "start": 2210, "length": 11 }, …],
      "prose": [{ "file": "…/CLAUDE.md", "line": 12 }] },
    { "at": "…/file-sink.ts:216:3", "from": "readJsonlTail", "to": "readJsonlTailSync",
      "status": "refused", "reason": "collision", "detail": "readJsonlTailSync is already bound in file-sink.ts (import from ./read)" } ] }
```

- **Plan, then apply** (the relocate split: `cli/internal/plan.ts` pure and
  tested). One program is built per plan, and every row's locations are found
  in it. Nothing is written and nothing is rebuilt per row. Each location
  belongs to exactly one row. Two rows that reach the same span are refused
  at plan time (`overlap`, or merged when they agree on the new name), so a
  row dropped from the plan takes exactly its own edits with it.
- **`--apply` re-validates what it can without a program:** every file's
  hash against the plan, overlaps among the kept rows, and each range still
  holding its old text. It does not re-run collision checks. Dropping a row
  only removes edits, and a collision is a property of a rename that was
  made, not of one left out. Dropping a row does leave that symbol's callers
  on the old name; this is the point (the symbol keeps its name). Edits apply
  back-to-front per file. That is relocate's applier, lifted to a shared
  `core`.
- **Declaration facts on every row** (`decl`, `reach`). What the `*Sync`
  agent needed a program for (is the owner `async`? is it an interface
  member? how far does it reach?) is printed, so a filter over the plan is a
  `jq` line, and a row with a surprising reach (§4: `DataDirArea.file`, an
  interface method) is visible before anything is written.
- **Refusals are rows, not silence.** `no-symbol` (nothing renameable at
  `at`), `expect-mismatch`, `collision` (the new name is already bound in a
  scope a location sits in, or exported by a barrel it would join),
  `outside-repo` (a node_modules / lib symbol), `generated` (rename its
  source) and `overlap` (two rows rename the same span to different names).
- **No alias prefixes**: `providePrefixAndSuffixTextForRename: false`,
  always. A shorthand property or binding is expanded deliberately
  (`{ read }` → `{ readSync }` when the local is the same symbol), and listed
  otherwise.
- **Prose:** comments and JSDoc come from `findInComments`. Markdown mentions
  are found with relocate's mention model (`` `oldName` `` in `*.md` and
  CLAUDE.md, outside AUTOGENERATED blocks). They are listed in `prose` by
  default; `--prose rewrite` rewrites them. `research/` is never rewritten:
  it records what was true when it was written.

### Where custom logic plugs in

The custom logic was always about **which** symbols and **what new name**,
plus filters and a fixpoint loop. The verb takes that as data and keeps the
mechanics:

1. **Spec in.** The agent's script turns its source of targets (lint output,
   `rg`, a list) into spec rows. It is a text transform with no TypeScript
   program; `to` is computed there (`name + "Sync"`).
2. **Plan out.** `--plan` writes the plan. A domain filter ("skip async
   owners", a denylist) runs over the spec (by name and path) or over the
   plan (by `decl` / `reach`), in a few lines, and holds no program.
3. **Apply the reviewed plan.** `--apply` takes the filtered plan; dropping a
   row from the JSON is how a row is skipped.
4. **Fixpoint:** the agent's loop re-runs its target query, then plans and
   applies again. Each pass costs one program plus the type-check the loop
   runs anyway (§4 measures both).

There is no plugin slot or hook API. An in-process API (a script importing
`planRename`) would put the program back in the script's unadmitted process,
which is the cost this removes. The spec/plan JSON is the extension surface.
Call-shape codemods stay scripts: they are per-file and cheap (190–220 MB
measured, §4), and their logic is the whole point.

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

Measured on this tree (2026-11-09), each run separately under
`/usr/bin/time -l`, heap-paced (`BUN_JSC_forceRAMSize` = 4 GB, as
`./equin run` and type-check batches run). The contracts were the tree's
emitted `.d.ts`, standing in for type-check's store (method in §4).

| program | sources | max RSS | wall |
| --- | --- | --- | --- |
| scoped: `FileSink.readJsonlTailSync` | 8 | 0.42 GB | 10 s |
| scoped: `openOwnedFdSync` | 14 | 0.52 GB | 11 s |
| scoped: `readIfExistsSync` | 18 | 0.44 GB | 7 s |
| scoped: `DataDir.ensure` | 92 | 0.85 GB | 19 s |
| scoped: `FileSink.append` | 277 | 1.17 GB | 24 s |
| scoped: `SleepMeter.read`, narrowed | 1,462 | 1.96 GB | 22 s |
| scoped: `SleepMeter.read`, not narrowed | 5,232 | 3.32 GB | 82 s |
| whole program, 5 rows (the `scratch-rename.ts` method, paced) | 15,607 roots (19,493 program files) | 4.01 GB | 30 s (25 s is the build) |
| whole program, 6 rows + per-row implementation lookup, **unpaced** | same | 5.31 GB | 60 s |
| `scratch-rename.ts` itself (unpaced, 2026-11-06 sample) | 15k | 7.2 GB | ~54 min (rebuilt per row) |
| per-file codemod pass (`createSourceFile`, no program) | 512 / 15,594 files | 0.19 / 0.22 GB | 5 / 13 s |

The scoped and whole programs found identical location sets on all six rows
(28, 44, 6, 46, 11 and 5 locations; `read` compared against the unpaced
whole run). The roots are the tsconfig's 15,607 files; 15,594 of them are
`.ts` / `.tsx` sources, which is the per-file count.

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

## 4. Counterfactuals: the audited cases, replayed against the verb

Asked for by the user (D11) before deciding: for real cases from §1, what
the agent would have written and seen with `./equin refactor rename`.
Everything marked *measured* was run on this tree on 2026-11-09. The rest
is labelled *estimate*, with the measurement it is bracketed by.

**Method.** The scripts were scratch, under `.scratch-measure/`, never
committed. `emit.ts` writes every file's `.d.ts` once, standing in for
type-check's contract store: 10.2 GB, 655 s, run once. The verb would read
the store that check runs keep, and would never do this. `scoped.ts` builds
the scoped program the way `NameHost` does: candidate files as source; every
other `x.ts` hidden behind a virtual `x.d.ts` holding its contract; global
scripts as roots. It then calls `findRenameLocations` at the declaration.
`full.ts` is `scratch-rename.ts`'s method: one language service over the
root tsconfig, run paced, and once unpaced with the original's per-row
`getDefinitionAtPosition` / `getImplementationAtPosition`. Those cost
0.1–1.5 s per row, so they do not explain the original's 10-minute dry run.
The unions are `git grep -lw` at `ba3124522c^`, saved with the outputs. `rclosure.ts` computes a reverse import closure from regex
specifiers; `perfile.ts` is a per-file `createSourceFile` pass. Each run was
separate, under `/usr/bin/time -l`, heap-paced. Results are in §3's memory
table. Two limits: `scoped.ts` scans files in JS (2–5 s, 19 s unnarrowed),
where the verb would use `rg`; and emitted `.d.ts` are not type-check's
canonical contracts (its unservable handling is absent).

### Example 1 — the `*Sync` migration (2026-11-06), replayed

**What happened:** see §1.A. In short: a scratch inventory (5.3 GB) produced
the targets; a 136-row TSV became 76 unique owners; the script was
rewritten 3 times; there were 3 cascade passes (35 / 23 / 8). Mid-cascade,
the agent saw that the cascade had renamed 5 spawn-priority helpers only
because of an `existsSync` probe of `taskpolicy`, and that it had renamed
`DataDirArea.file`, an interface method with many callers. It removed the
probe, reverted all six with `perl`, and stopped the cascade by hand
(paths core went to debt).

**What the agent writes.** One spec script of about 15 lines, a text transform. The denylist is the
one the original agent had built by its last pass:

```ts
// .scratch/sync-spec.ts — `./equin check type-check` output on stdin → spec rows on stdout
const reach = new Set((await Bun.file(process.argv[2]!).text()).split("\n")); // files a backend loads
const deny = [/\/guards\//, /effective-on-disk\.ts/, /git-layer\.ts (read|exists)$/,
              /mise-updater\.ts (apply|prepare|plan)$/, /flock\/core\/internal\/wait\.ts/,
              /ticket-line\.ts/, /data-dir\.ts ensure$/];
const finding = /^\s*(\S+):(\d+):(\d+)\s+blocking-fs\/sync-named\s+`(\w+)` blocks its thread.*name it `(\w+)`/;
for (const line of (await Bun.stdin.text()).split("\n")) {
  const m = finding.exec(line);
  if (!m) continue;
  const [, file, l, c, name, to] = m;
  if (!reach.has(file!) || deny.some((d) => d.test(`${file} ${name}`))) continue;
  // the finding sits on the blocking call INSIDE the owner: name the enclosing declaration
  console.log(JSON.stringify({ in: `${file}:${l}:${c}`, name, to }));
}
```

The finding format is the one check logs print today:
`data-dir.ts:430:32  blocking-fs/sync-named  `ensure` blocks its thread (`resolveInSync`): name it `ensureSync`.`
Its position, 430:32, is the `resolveInSync(…)` call inside `ensure`, not
`ensure`'s own name. That is why the row uses `in` + `name`.

**CLI calls, per pass:**

```sh
./equin check type-check > "$EQUIN_SCRATCH/check.txt"           # fails: the rule's findings
./equin run .scratch/sync-spec.ts reach.txt < "$EQUIN_SCRATCH/check.txt" > spec.jsonl
./equin refactor rename --spec spec.jsonl --plan plan.json
jq '.rows |= map(select(.decl.async | not))' plan.json > kept.json   # the async skip
./equin refactor rename --apply kept.json
```

**The plan it sees.** Pass 1 is abbreviated below. The rows, the reach
numbers and the 76 / 53 / 23 split are the real 2026-11-06 dry run with the
denylist above applied. The union is measured at `ba3124522c^`: 1,209 files,
969 of them from `close` and 157 from `spawnCaptured`. The `status` and
`decl` columns are illustrative.

```
plan: 53 rows (76 findings, 23 denied by the spec) · engine scoped (union 1,209 sources ≤ 1,500)
  rename  apps/browser/…/code-id.ts:27      hostCodeId → hostCodeIdSync          function, exported      5 locs / 3 files
  rename  config_v2/…/git-layer.ts:170      appIds → appIdsSync                  function                7 locs / 2 files
  rename  …/scratch/core/claude-trust.ts:80 ensureDirTrusted → …Sync             function, exported      5 locs / 3 files
  rename  owned-fd/…/owned-fd.ts:84         openOwnedFd → openOwnedFdSync        function, exported      5 locs / 3 files
  rename  icon-sets/…/symbol-names.ts:88    readIconSet → readIconSetSync        function, exported      9 locs / 3 files
  rename  paths/…/data-dir.ts               inspectMove → inspectMoveSync        function                3 locs / 1 file
  rename  spawn-priority/…/background.ts    prefixTokens → prefixTokensSync      function                4 locs / 1 file
  …
```

In passes 2–3 the plan would also show the rows the original met only
after the apply:

```
  rename  paths/…/data-dir.ts:427   file → fileSync            method of DataDirArea (interface)   6 locs
  rename  writer.ts:122             pruneRuns → pruneRunsSync   function  async: true   (dropped by the jq filter)
```

- **Async skip:** a `jq` line over `decl.async`. The original needed this
  because the lint rule flagged async owners (a false positive). The
  structural fix is in the rule. The verb only makes the stopgap trivial.
- **Denylist:** unchanged, in the spec script (a regex list, as before).
- **Collisions:** the original refused `readTail` / `readJsonlTail` on a
  *textual* test (`<name>Sync` already appears in the file). There, the
  object-literal method `readJsonlTail` sits beside an imported function
  `readJsonlTailSync`. A property name binds nothing in scope, so the verb's
  scope-aware check lets the rename through, by TypeScript's binding rules
  (not measured). In the original, after that skip, the post-apply check
  flagged `FileSink.readJsonlTail` call sites. The agent fixed three of them
  by `perl` (`s/\.readJsonlTail</.readJsonlTailSync</`). The verb renames the
  member as one symbol, so its call sites move with it, but the transcript
  does not fully show how the original got half-renamed.
- **The cascade decisions stay the agent's.** `DataDirArea.file` and the
  spawn-priority helpers appear in the plan as an interface method and
  functions, with their reach, **before** anything is written. The original
  agent saw them after the apply and reverted with `perl`. Whether
  to rename, redesign (drop the `taskpolicy` probe) or file debt is still
  judgment; the verb only moves the moment of review earlier.
- **Fixpoint:** the agent's loop repeats the five lines (one `./equin
  check`, then spec, plan, filter, apply). Each rename makes its
  callers blocking-named, so the next `check` prints the next rows. That is
  3 more rounds (35 / 23 / 8), each with its own plan and review. This is
  inherent in the rule working by induction; the verb does not collapse it.

**Post-apply type-check:** the same `./equin check type-check` that starts
the next pass. It verifies the renames and lists the next findings in one
run.

**Time and memory, against what happened:**

| step | 2026-11-06 (actual) | with the verb |
| --- | --- | --- |
| targets (inventory) | scratch typed-ESLint over the whole program: 5.3 GB, ~81 s per pass | `./equin check type-check` (run anyway). From 830 check logs (2026-10-22 → 11-09), worker runs whose program 1 held 101–300 sources: median 7.5 GB max RSS, 198 s (n = 15; p90 10.2 GB, 521 s). The 3 runs at 303–478 sources: 7.6–10.6 GB, 184–605 s (each also linted ~15k files). Max over 101–600 sources: 13.9 GB. Admitted, heavy pool |
| rename, pass 1 | dry run ~10 min; apply v1 ~54 min; v2 4 min 09 s; 7.2 GB (unpaced) | *estimate:* one scoped program of 1,209 sources, below the measured 1,462-source program (1.96 GB, 22 s), plus ~0.2–3 s per row; narrowing `close` would shrink it further |
| passes 2–4 | 3 × ~4 min (inventory + rename) | 3 × (~25 s rename, same bracket, + the type-check above, ~3–10 min) |
| script rewrites | 3 (alias prefixes, per-row rebuild, collisions / async) | 0 — a spec script and a `jq` filter |
| reverts after the fact | `perl` revert of 5 helpers + `DataDirArea.file` | dropped from the plan before apply (the redesign decision is unchanged) |

The honest part: the loop's memory peak and most of its wall time are now
the **type-check**, not the rename. That check is a cost a well-run session
pays anyway, and it is admitted. It replaces the inventory, but each pass is
**heavier and slower** than the original's inventory (median 7.5 GB / 198 s
against 5.3 GB / 81 s). The rename itself drops from ~70 min of compute,
with a 7.2 GB sample, to about 1–3 min at ≤ 2 GB (estimate, bracketed above).
Against a careful whole-program script written today (4.0 GB paced, ~1 min,
measured), the verb saves memory and admission, not time.

### Example 2 — `sed` renames

**2a. `MergedDataView*` → `DataViewSwitcher*` (2026-10-17, `b19d3ee896`):
`sed` was right.** The command was
`rg -l … plugins -g '*.ts' -g '*.tsx' -g CLAUDE.md | xargs perl -pi -e 's/MergedDataViewBaseProps/…/g; s/MergedDataViewProps/…/g; s/MergedDataView/…/g'`.
At the parent commit the names were in 15 / 2 / 1 / 1 `.ts` files and 14
`.md` files (9 of them in `research/`, which the glob left alone).

With the verb, the agent writes 4 hand-made rows:

```jsonl
{"at":"plugins/primitives/plugins/data-view/web/…/merged-data-view.tsx:L:C","expect":"MergedDataView","to":"DataViewSwitcher"}
… (MergedDataViewProps, MergedDataViewBaseProps, MergedSourceBody)
```

It then runs `--plan`, sees 4 renames (scoped, about 19 sources, in the
measured 8–18-source class of 0.42–0.52 GB and 7–11 s) and prose mentions
in 3 CLAUDE.md files and 2 other non-research `.md` files, and applies with
`--prose rewrite`. (The rename was one step of a 74-file feature commit; the
`sed` line is the step replayed here.) The result is the same
as the `sed`. It costs ~10 s and a spec instead of milliseconds, and it
renames no files either (`merged-data-view.tsx` is a `git mv`). **The verb
is not needed here.** The discovery inform (§3) does not fire, since every
name is in fewer than 50 files, and that is by design.

**2b. `handoff` → `handoffRef` (2026-10-24, row-actions.tsx): `sed` was
risky, and right by luck.** The command was
`perl -pi -e 's/\bhandoff\b(?!Ref)/handoffRef/g unless /^\s*\/\/|^\s*\*/'`
on one file. The word named four things: a local (`const handoff = useRef(…)`),
a props member (`handoff: RefObject<…>`), a JSX attribute (`handoff={handoff}`)
and a destructuring (`{ handoff }`). Comments were skipped only when a line
started with `//` or `*`. The agent wanted all four renamed, so the regex
did what was meant. Nothing in the command would have shown it if it had not.
With the verb this is **two rows**, because two symbols are involved: `at`
on the `const` and `at` on the props member. The destructuring and the
attribute follow their symbols, and the comments come back as `prose`.
That is more exact, and more work for a one-file rename.

**2c. `DiskRead.read` → `readSync` (effective-on-disk.ts:31, inside the
`*Sync` case): `sed` was impossible.** `read` is in 5,175 files, and the row
has 32 real locations in 11 files. This row is why the agent built a
language service. With the verb it is one row. The engine is scoped after
narrowing. The measured analogue is `SleepMeter.read`: 5,232 candidates
narrowed to 1,462, 1.96 GB, 22 s, the same 5 locations as the whole program.
The bracket is honest, but not small: a common member name in a widely
imported module still costs a ~2 GB program.

### Example 3 — where the verb does not help: `useLiveRow(a, b)` → `useLive(a, { id: b })`

2026-10-28: 113 calls in 88 files, with imports merged and kept sorted. It
is not a rename. Renaming `useLiveRow` to `useLive` would be refused
(`collision`: `useLive` is already exported by the same barrel), and the
argument reshaping is not a rename at all. The agent writes the same per-file
codemod it wrote: an `rg -l` prefilter, `createSourceFile`, edits
back-to-front, and an import fix. *Measured class:* a `createSourceFile` pass
over the 512 files that mention `useLive(` is 0.19 GB / 5 s, and over all
15,594 files 0.22 GB / 13 s. The guard does not fire (no program), and that
is correct: this script was never a memory problem.

The adjacent case shows the guard's limit. The user-path codemod
(2026-10-30) built `createProgram` over 5 dirs only to read TS2345
diagnostics, then wrapped each span. As specified, the guard fires only on
a program over the root tsconfig's `fileNames`, so it would miss this one.
Its cost was not measured. The program was not needed: `./equin check
type-check` prints the same diagnostics with positions, and a per-file edit
over them needs none. The guard's hint should say so, and its match should
cover `createProgram` over any tsconfig-derived option set
(open point in §5).

### What the examples changed in the design (applied above in §3)

1. **One program per plan, sized by the union, with the whole program as the
   large-union engine.** The first sketch implied a scoped program per row or
   batch. Measured, one scoped program costs 7–24 s however few its rows,
   against 0.2–3 s per extra row (11 s for `read`) once built. The pass-1 union (53 rows) is
   1,209 files, which is scoped. The union of all 93 `*Sync` names is 6,961
   files; for a spec that large, one whole program (4.0 GB / 30 s) beats
   many large scoped ones.
2. **Rows name their symbol by position: `at` (a position of it) or `in` +
   `name` (the declaration enclosing a position).** The first sketch said a
   lint finding prints the symbol's position. It does not: `sync-named`
   reports the blocking call inside the owner, so `at` would name the callee.
   The independent review caught this. `in` + `name` is the original's
   "nearest identifier above the line" made exact by containment.
3. **Declaration facts and reach in the plan.** Without them, the async skip
   needs a program in the agent's script, and the `DataDirArea.file` cascade
   is found only after the apply.
4. **Scope-aware collisions,** not the textual `\bnameSync\b` test, which
   refused a safe row and produced the one straggler.
5. **Not fixed by the verb:** the fixpoint's per-pass cost is a type-check.
   The spec script parses check text output. A machine-readable findings
   output (`./equin check <id> --findings-json`) would make it robust. That
   is a separate change, listed in §5.

## 5. Recommendation and open points

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
- **Acceptance test, partly done (§4):** on 6 rows the scoped and whole
  programs found identical locations, with peaks measured. Before building,
  run all 93 `*Sync` names (at `ba3124522c^`, against type-check's real
  contract store rather than emitted `.d.ts`) and require equal location
  sets. Measure the 1,209-source pass-1 program that §4 estimates.
- **Guard reach:** match `createProgram` / `createLanguageService` over any
  options read from a tsconfig, not only the root's `fileNames`. That covers
  the user-path codemod, whose program existed only to read diagnostics
  `./equin check type-check` already prints.
- **Findings as data:** `./equin check <id> --findings-json` (file, line,
  col, rule, message) would let spec scripts stop parsing check text. It is a
  separate change; the verb does not need it to work.
