# Guards: parse a command's file arguments instead of guessing them

## Context

The `main-writes` PreToolUse guard blocks writes from an agent worktree into the
main checkout. It decides *what a command writes* with one line:

```ts
const nonFlag = call.args.filter((a) => !a.startsWith("-"));
```

then `resolve(call.cwd, …)` on the survivors. That is not a parse — it is a
guess. Anything in the argv that is not flag-shaped becomes a path.

The report that started this: a `sed -i '' 's|…|…|' <file-in-worktree>` was
blocked, and the "path" the guard named was a fragment of the **substitution
script**. `path.resolve` normalised the `..` sequences inside the script text and
landed it under the repo root. The file actually being edited was in the
worktree.

Blocking is the safe direction. But a guard that misparses its input teaches
agents that its blocks are noise, and that is the failure mode that matters — a
guard nobody believes is a guard nobody obeys.

### What the corpus says

Replaying every Bash guard over 30 days (437 sessions, 27,817 Bash calls) gives
1414 denials. Bucketing `main-writes`'s 60 by reason:

| count | reason |
| --- | --- |
| 55 | redirection target `'&1'` is under `<MAIN>` |
| 3 | `git target '<MAIN>'` — **real** |
| 1 | `sed target '<MAIN>/..");|const REPO_ROOT = …'` — the reported bug |
| 1 | redirection target `'../../provision'` |

**92% of this guard's real-world denials are `2>&1`.** `scanRedirections` in
`parse-shell.ts` matches `/(>>|>)\s*(\S+)/`, so `cmd 2>&1` yields a redirection
whose target is `&1`; after a `cd <main>` that resolves to `<main>/&1`. Every
`cd <main> && <read-only inspection> 2>&1` denies. Same defect class as the sed
bug — misparsing the input — and an order of magnitude more common. It is
already known-by-symptom: `poll-detect.ts` carries a local
`if (target.startsWith("&")) return false;` patch on the shared parser's bug.

### The guard is also weaker than it looks

Confirmed against the live guard, all currently **allowed** and all genuine
writes into main:

| command (cwd = worktree) | why it slips |
| --- | --- |
| `cd <main> && rm -- -weird` | `--` terminator ignored; `-weird` filtered as a flag |
| `perl -pi -e 's/a/b/' <main>/x.ts` | `-pi` cluster missed by `startsWith("-i")` |
| `sed --in-place 's/a/b/' <main>/x.ts` | long form missed |
| `cp -t <main> a.ts` | `-t` is the destination, not a flag to skip |
| `rsync -a src/ <main>/dst/ --exclude foo` | trailing value flag steals "last operand" |
| `git -c user.name=x -C <main> commit -m y` | `args[0] === "-C"` probe sees `-c` first |
| `install -d <main>/newdir` | `-d` creates dirs; dest-last bails on one operand |

So this is not a trade of safety for quiet. Parsing properly makes the guard both
quieter **and** stronger.

### Intended outcome

One place in the guards plugin knows how a command's argv splits into flags and
file operands. Guards ask it; no guard invents a path from a token again.

---

## Design

### 1. `core/parse-shell.ts` — redirections that name a file

`2>&1` duplicates a file descriptor; it opens nothing. `>&word` (word not a
descriptor) is bash's synonym for `&>word` and *is* a file.

```ts
for (const m of masked.matchAll(/(>>|>)\s*(\S+)/g)) {
  const raw = m[2]!;
  if (/^&(\d+|-)$/.test(raw)) continue;        // fd dup / close: opens nothing
  const target = raw.startsWith("&") ? raw.slice(1) : raw;
  out.push({ op: m[1] as ">" | ">>", target });
}
```

Then delete `writesAFile`'s `startsWith("&")` workaround in `core/poll-detect.ts`
and leave a comment naming `scanRedirections` as the owner — a workaround left
next to its fixed cause is an invitation to re-add it elsewhere.

### 2. `core/argv.ts` (new) — the operand grammar

```ts
export type FileOperand =
  | { kind: "local"; raw: string; path: string }   // resolved against call.cwd
  | { kind: "remote"; raw: string };               // rsync/scp [user@]host:path

export interface ParsedArgv {
  files: FileOperand[];          // positional operands that name a file
  targetDir?: FileOperand;       // -t / --target-directory, git -C
  leading?: string;              // sed script, chmod mode, git subcommand — RAW
  flags: ReadonlySet<string>;    // short letters bare, long names undashed
}

export function parseArgv(call: ShellCall): ParsedArgv;
export function redirectionTargets(call: ShellCall): FileOperand[];
export type KnownCommand = keyof typeof COMMAND_GRAMMAR;
```

Driven by a per-command table of flag arities:

- `consumed` — takes the next token (or its cluster tail); that value is never a
  write target (a mode, size, date, suffix, script, or a path only *read*).
  Read-paths and non-paths share one arity deliberately: both leave the write
  set, and an axis no consumer observes is an axis that rots. Which is which is
  recorded per entry in a comment.
- `dir` — takes the next token, and it IS the destination directory.
- `attached` — an optional value that must be glued (`-i.bak`, `--backup=simple`);
  never takes the next token.

**The BSD/GNU `sed -i` resolution.** BSD wants a separate suffix
(`sed -i '' 's/a/b/' f`), GNU forbids one (`sed -i 's/a/b/' f`). Model `-i` as
`attached` (no separate value) **and drop empty-string operands** — an empty
string can never name a file — and both spellings parse to `["f"]`. Dropping
empty operands also kills a live bug: `resolve(cwd, "")` is `cwd`, so today an
empty operand silently *means the working directory*.

The walk, left to right:

1. `--` ends options; everything after is an operand even if `-`-leading.
2. Bare `-` is a stream, not a file.
3. `--name=value` self-contained; `--name` consults the table for the next token.
4. `-abc` walks letter by letter (the `rg-replace.ts` idiom): the first
   `consumed`/`dir` letter takes the cluster tail if non-empty else the next
   token; an `attached` letter takes the tail and ends the cluster.
5. `leadingPattern` (chmod's symbolic mode `-w`, `-rx`) before the cluster walk.
6. First positional fills `leading` when the grammar declares one and no
   suppressing flag appeared (`-e`/`-f` for sed/awk/perl, `--reference` for
   chmod/chown/chgrp).
7. Empty operands dropped.
8. `remoteSpecs && /^[^:/]+:/` → `{kind:"remote"}` (rsync's own heuristic).

Commands covered: `cp mv rsync install rm rmdir tee touch mkdir chmod chown chgrp
truncate shred ln unlink sed perl awk git`, plus coreutils `g*` aliases
(`gsed`, `gawk`, `gcp`, …) which are policed by nothing today.

**Totality, not fallibility.** Every argv has exactly one answer; an unknown
command falls through to the default grammar (today's behaviour). `files: []` is
legitimate emptiness — `git status` and `sed` without `-i` genuinely write
nothing — not an absorbed failure. This runs in a PreToolUse hook on every Bash
call; an unknown command must parse conservatively, never fail the tool call.

**Why resolved paths, not raw strings.** `parse-shell.ts` already warns that a
call's relative args must be resolved against `call.cwd` or `cd <dir> && rm <rel>`
slips past. Doing the resolve inside the parser makes that unforgettable. `raw`
is kept beside it so guard messages echo what the agent typed.

**No `reads` output.** No caller needs one, and a partial one would be a
half-truth: `sed -i` reads its input files too, so a read set built from
`-r`/`-f`/`--reference` alone would systematically understate. Add it when a
caller exists.

### 3. `core/guards/main-writes.ts` — compose on top

```ts
type Policed = KnownCommand;
const DEST_LAST_CMDS = new Set<Policed>(["cp", "mv", "rsync", "install"]);
```

That `Set<Policed>` annotation is **rung 2**: policing a command with no grammar
entry becomes a compile error, so the two sets cannot drift.

`writeTargets` becomes: `install -d` → every operand; `targetDir` beats position
(`cp -t <dir> a b` writes `<dir>`, and reading the last operand there wrote to a
*source*); otherwise last operand when there are ≥2. In-place reads
`flags.has("i") || flags.has("in-place")` — the flag *set*, so `perl -pi` and
`sed --in-place` are caught and an `-i` that was another flag's value is not.
`git` reads `argv.leading` as the subcommand and `argv.targetDir` as `-C`;
`gitDir()` is deleted.

The redirection loop uses `redirectionTargets(call)`, which removes `node:path`
from the file entirely — a prerequisite for the lint rule below.

**rsync remote specs matter in both directions.** `rsync a user@host:/p` → the
destination is `remote`, nothing local is written, no denial. `rsync user@host:/p
<main>/dst` → the remote source keeps its *position*, so "last operand" still
lands on `<main>/dst` and denies. That is why remotes stay a discriminated case
instead of being filtered out — filtering would shift positions and re-point the
destination.

### 4. `core/guards/migrations.ts` — same helper

`c.args.some((a) => a.includes("migrations/data/"))` is the same antipattern.
Becomes `parseArgv(c).files.some(isMigrationData)`. It cannot weaken (`rm` has no
value flags and no leading operand) and it gains post-`--` operands plus
`rm -rf …/migrations/data` with no trailing slash.

### 5. Lint rule — `guard-path-safety/no-adhoc-path-resolve`

A rule keyed on `.args.filter(` would be the wrong rule: five guards read `.args`
legitimately for non-path reasons, so it would be more allowlist than rule.

Invert it — **ban the path constructor, not the argv reader**: inside
`…/guards/core/guards/**`, importing `resolve`/`join`/`normalize` from
`node:path` is an error; every path a guard compares comes from `core/argv.ts`.
Self-limits by filename in-rule (the `no-adhoc-check-runner` precedent), so being
configured repo-wide is harmless. One named exemption: `main-edits.ts` resolves a
*tool input* `file_path`, not shell argv.

New sub-plugin at
`plugins/framework/plugins/tooling/plugins/lint/plugins/guard-path-safety/`.

There is no rung-1 available — `.args` must stay `string[]` for the guards that
legitimately read it. Say so rather than invent one.

### Documented residual gaps

- BSD `sed -i .bak 's/a/b/' f` (non-empty separate suffix): `.bak` fills the
  leading slot, so the script stays in `files` and may false-deny. Over-blocking
  direction; the file it really edits is still caught.
- An unmodelled rsync value flag placed *after* the destination still steals the
  last-operand slot. Today's behaviour for every flag, so strictly reduced. Not
  closed because the alternative would deny `cp --archive <main>/file .` — copying
  *out of* main is legitimate and common.
- `ln -s <main>/a b` over-blocks (`ln` writes only the link name). A semantic
  change, not a parsing fix; kept out so the replay numbers stay readable.

---

## Files

- `plugins/framework/plugins/tooling/plugins/guards/core/argv.ts` (new)
- `plugins/framework/plugins/tooling/plugins/guards/core/argv.test.ts` (new)
- `plugins/framework/plugins/tooling/plugins/guards/core/parse-shell.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/parse-shell.test.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/poll-detect.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/guards/main-writes.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/guards/main-writes.test.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/guards/migrations.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/index.ts`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/guard-path-safety/**` (new)

## Sequencing

1. Redirection fix + tests; delete `poll-detect`'s `&` workaround.
2. `core/argv.ts` + tests; export from the barrel.
3. Rewrite `main-writes.ts`; extend its tests.
4. Reroute `migrations.ts`.
5. `guard-path-safety` lint rule + `./equin build`.
6. Update the guards plugin `CLAUDE.md` with the residual gaps.

## Verification

- `./equin test plugins/framework/plugins/tooling/plugins/guards`
  (baseline today: 162 pass / 0 fail).
- `bun …/guards/e2e/replay-transcripts.ts --guards --assert` before and after,
  diffing the per-guard table. Expected signature: `main-writes: 60 → ~10`, every
  other guard unchanged. Movement elsewhere means the redirection change leaked.
- `bun …/guards/e2e/replay-transcripts.ts --assert` (default mode) —
  `classify()` reads redirection targets, so deleting the `&` workaround must
  leave `FLOOR_SESSIONS=60 / FLOOR_PREVENTED=1000` intact.
- **Do not lower any floor.** Refresh the measured figures in the
  `FLOOR_BASH_DENIES` doc comment with today's corpus and the post-change
  `main-writes` number — that comment is the record of what the floors were
  calibrated against, and a false-positive purge is exactly what it should note.
- `./equin check` (lint rule, docs-in-sync) and `./equin build`.
- End to end: from this worktree, re-run the reported command
  (`sed -i '' 's|…"../../../..");|…"..");|' cli/singularity.ts`) and confirm it
  is allowed, and `sed -i '' 's|a|b|' <main>/x.ts` and confirm it still denies.
