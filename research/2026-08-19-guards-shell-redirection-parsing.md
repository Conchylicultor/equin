# One parsing pass for shell words and redirections

## Context

A PreToolUse guard falsely blocks read-only commands. Running any command that merges stderr
into stdout while the shell sits in the main checkout is denied:

```
cd /Users/epot/__A__/dev/singularity && git worktree lock "$p" --reason x 2>&1

  Blocked write to main branch: redirection target '&1' is under
  /Users/epot/__A__/dev/singularity (outside worktree ...)
```

`2>&1` duplicates a file descriptor; it is not a path. Nothing is written. The guard's message
tells the agent to stop and ask the user, so each false positive costs a full round trip.

Encountered while locking existing agent worktrees against Claude Code's worktree sweep.

The false positive is one symptom of a broken grammar, and the same grammar hides real writes to
main. Every line below was reproduced by running the parser at `baseCwd = "/repo"`:

| command | parser says | truth |
| --- | --- | --- |
| `git worktree lock x 2>&1` | write to `&1` | fd duplication — **false block** |
| `echo hi >&2`, `cmd >&-` | write to `&2` / `&-` | fd dup / fd close — **false block** |
| `rm x &>/dev/null` | `rm` arg `&>/dev/null` | a redirection posing as a path — **false block** |
| `tee >(cat) < f` | write to `(cat)`, args `<`, `f` | process substitution — **false block** |
| `[[ "$a" > "$b" ]]` | write to `]]` | string comparison — **false block** |
| `echo x > "<main>/notes.txt"` | *no redirection at all* | **a write to main, unseen** |
| `echo x >\| <main>/notes.txt` | redirection lost, phantom call | **a write to main, unseen** |
| `ls >&/tmp/out` | write to `&/tmp/out` | bash sends both streams to `/tmp/out` — **wrong path** |
| `tee >(sh -c "rm <main>/x")` | inner `rm` never emitted | **a command hidden from every guard** |

### Root cause

`plugins/framework/plugins/tooling/plugins/guards/core/parse-shell.ts` derives the same grammar
twice, in two places, from two different views of the text:

- `scanRedirections` regexes `/(>>|>)\s*(\S+)/g` over a copy with **quoted regions masked to
  spaces** — so it treats whatever word follows `>` as a file path, and loses a target that was
  quoted (the mask erased it).
- `stripRedirections` regexes the **token list**, after `shellSplit` has already erased the quotes
   — so it decides separately which tokens were redirections, and misses the ones it spells
  differently (`&>file`).

Two independent, weaker re-derivations of one grammar are guaranteed to disagree. Every row of the
table above is a disagreement.

The knowledge that a target may not be a path already exists in the codebase — `poll-detect.ts`
carries a local `target.startsWith("&")` workaround with a comment explaining `2>&1`. That is the
documentation rung (weakest, reaches only whoever reads it); `main-writes.ts` never got the memo.
Fixing it in the parser is what stops the next consumer from having to know.

## Design

### 1. The type states which redirections have a path

In `core/parse-shell.ts`:

```ts
/**
 * One OUTPUT redirection. Input redirections (`<`, `<<`, `<<<`, `<&`) are consumed by the
 * parser and never surface: they write nothing, and left in the token stream they pose as
 * positional args (`cp a b < c` made `c` cp's destination).
 *
 * The left-hand fd is deliberately absent — `2>log` and `>log` write the same file.
 */
export type ShellRedirection =
  | { kind: "file"; op: ">" | ">>"; path: string }
  | { kind: "fd"; op: ">" | ">>"; toFd: string };
```

- `path` is the word as written, quotes removed and the `&` of `>&<path>` stripped. The consumer
  still resolves it against `call.cwd` (`poll-detect` parses with no `baseCwd`, so the parser must
  not pre-resolve).
- `toFd` is `"1"`, `"2"`, `"1-"` (fd move) or `"-"` (close).
- **Rename `target` → `path`.** This is what makes the migration safe: every stale `r.target` read
  fails to compile instead of silently working on a differently-shaped value. `target` was the lie
  itself — it named "the word after the operator", which is exactly the bug.

Rung 2 (type error): `resolve(cwd, r.path)` does not compile until the consumer narrows on `kind`.
Simply omitting fd dups from the list would also fix this bug, but an empty `redirections` would
then mean either "none" or "only fd dups" — the absorbable value the house rules ban — and the fact
would be unrecoverable for a future guard.

### 2. One quote-aware pass replaces three functions

`shellSplit`, `stripRedirections` and `scanRedirections` collapse into a single `splitCommand(seg)`
returning `{ words, redirections }`, so words and redirections come from **one** walk of the text
and cannot disagree. `collectSegment` (~line 157) becomes:

```ts
const { words, redirections } = splitCommand(head);
const tokens = stripGroupParens(words);
```

The word reader is today's `shellSplit` inner loop, one word at a time, additionally stopping at an
**unquoted** operator (so `echo a>b` yields the word `a`, as bash does) and reporting whether the
word it read was quoted.

Operator table, recognised only unquoted, after an optional fd prefix (`\d+` or `{name}`) glued to
the operator:

| spelling | meaning | surfaces as |
| --- | --- | --- |
| `>` `>>` | write / append to file | `file` |
| `>\|` | write, clobber override | `file` |
| `&>` `&>>` | both streams to file | `file` |
| `>&N` `>&N-` `>&-` | fd duplicate / move / close | `fd` |
| `>&<path>` | bash: both streams to that file | `file` (the `&` belongs to the operator) |
| `<>` | open for read-write | `file` (err toward a write) |
| `<` `<<` `<<<` `<&` | input | consumed, never surfaces |
| `>(cmd)` `<(cmd)` | process substitution | not a redirection — see step 4 |

A word following an operator is a fd only when unquoted and matching `^(?:\d+-?|-)$` after the `&`;
anything else is a path. A dangling operator at end-of-segment yields nothing (bash errors; nothing
is written).

`<<` is in the table defensively — `splitHeredocs` normally removes heredoc operators before this
point, but an arithmetic body (`$((1 << 2))`) reaches the word reader through
`extractSubstitutions`.

Small hardening, same pass: inside `[[ … ]]`, `<` and `>` are string comparison, so once `words[0]`
is `[[`, stop recognising them as operators for the rest of the segment.

### 3. `splitOnOperators`: stop splitting `>|`

`echo x >| main/file` currently splits at the `|`, dropping the redirection and minting a phantom
call named `file`. The existing `&` exception (~line 788) peeks at the raw previous character,
which can be a quote or an escape; replace that index arithmetic with a tracked "last significant
unquoted char" and cover both operators:

```ts
// `2>&1` / `&>file` / `>|file`: the `&` or `|` belongs to the redirection, not to us.
if ((c === "&" || c === "|") && (prev === ">" || (c === "&" && next === ">"))) {
  cur += c; prev = c; continue;
}
```

### 4. `extractSubstitutions` lifts `>(…)` / `<(…)`

Six lines next to the existing `$( … )` arm, and `collectSegment` already recurses into everything
returned in `inner` with the right cwd and depth:

```ts
// `>(cmd)` / `<(cmd)` run a command and expand to /dev/fd/N. Lifting the body here does three
// jobs: the inner command becomes a real call, the text can never be read as a redirection
// target, and it can never pose as an arg.
if ((c === ">" || c === "<") && next === "(") {
  const end = matchParen(s, i + 1);
  if (end !== -1) { inner.push(s.slice(i + 2, end)); i = end; continue; }
}
```

`tee >(sh -c "rm <main>/x")` then emits `sh` **and** `rm <main>/x`, so main-writes catches it for
free — a blind spot every Bash guard shared.

### 5. Consumers

`core/guards/main-writes.ts` (~line 103) — the reported bug dies here:

```ts
for (const r of call.redirections) {
  // A fd duplication (`2>&1`, `>&-`) names no file — resolving it against cwd is what
  // falsely blocked every read-only command run with cwd in the main checkout.
  if (r.kind !== "file") continue;
  const target = resolve(call.cwd, r.path);
  ...
}
```

`core/poll-detect.ts` (~lines 150–177) — its local workaround is deleted, not copied:

```ts
function writesAFile(r: ShellRedirection): boolean {
  if (r.kind !== "file") return false;
  return r.path !== "/dev/null" && r.path !== "/dev/stderr" && r.path !== "/dev/stdout";
}
// …
if (redirections.some(writesAFile)) return "mutate";
```

Also update the `ShellCall.redirections` doc comment (~line 14): resolve `kind: "file"` paths
against `cwd`. No barrel or doc regeneration is implied — `ShellRedirection` is imported as a type
by nobody, and both consumers live inside the guards plugin.

## Steps

1. Type + `splitCommand` + the operator matcher; delete `shellSplit`, `stripRedirections`,
   `scanRedirections`; rewire `collectSegment`. The two consumers stop compiling on `r.target` —
   that is the point.
2. `splitOnOperators`: the `prev`-tracked `>|` / `&>` exception.
3. `extractSubstitutions`: the process-substitution arm.
4. `main-writes.ts` and `poll-detect.ts` edits.
5. Tests, then the whole guards suite.

Steps 1–3 are one parser change; splitting them leaves the tree not compiling in between.

## Files

- `plugins/framework/plugins/tooling/plugins/guards/core/parse-shell.ts` — the whole change
- `plugins/framework/plugins/tooling/plugins/guards/core/guards/main-writes.ts` — narrow on `kind`
- `plugins/framework/plugins/tooling/plugins/guards/core/poll-detect.ts` — drop the workaround
- `.../core/parse-shell.test.ts`, `.../core/guards/main-writes.test.ts`, `.../core/poll-detect.test.ts`

## Tests

`parse-shell.test.ts`, extending the existing `redirections are not commands` block (add a local
`redirs = (cmd) => parseShell(cmd).redirections` beside the existing `names` helper). One case per
row of the Context table, asserting **both** the redirection arm and the args:

`2>&1` / `>&2` / `>&-` → `fd` arm, no path · `ls >&/tmp/out` → file `/tmp/out` ·
`rm x &>/dev/null` → args `["x"]` · `rm x &>>log` → `op: ">>"` · `echo x >| main/file` → no
phantom call, file `main/file` · `echo x > "my file"` → file `my file` · `cmd {fd}>f` → args `[]` ·
`echo a>b` → args `["a"]`, file `b` · `echo ">" > out` → args `[">"]`, file `out` ·
`cp a b < c` → args `["a","b"]` · `[[ "$a" > "$b" ]]` → no redirection ·
`tee >(cat) < f` → calls `tee`, `cat`, args `[]`, no redirections ·
`tee >(sh -c "rm main/x")` → calls include `sh` and `rm`.
Update the existing assertion at line 155 to the new shape.

`main-writes.test.ts` — the guard-level statements, using the file's existing fake `REPO` / `WT`
paths and `blocks()` helper:

- allowed (regressions of the reported bug): `cd ${REPO} && git worktree list 2>&1`,
  `ls -la &>/dev/null`, `ls >&-`, `tee >(cat)`, `cp a b < c`
- still blocked (the newly-closed bypasses): `echo x >| ${REPO}/notes.txt`,
  `echo x >&${REPO}/notes.txt`, `echo x &> ${REPO}/notes.txt`, `echo x > "${REPO}/notes.txt"`,
  `tee >(sh -c "rm ${REPO}/x")`

`poll-detect.test.ts` — one each way: `classify("ls >&2")` is not `"mutate"`;
`classify("cat x >| /tmp/saved.txt")` is `"mutate"`.

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/guards` (background) — the whole
   plugin, not just the two files: `background-ops`, `poll-loop`, `rg-replace` and `main-edits` all
   read the same parse, and dropping `<`-args from the token stream is the blast radius. Baseline
   today is 162 pass / 0 fail across 7 files.
2. End-to-end through the real hook entry point, which is what Claude Code runs
   (`.claude/settings.json` → `$CLAUDE_PROJECT_DIR/.../guards/bin/guard.ts`, so this worktree's
   copy is live the moment the file is saved — no build needed for the guard itself):

   ```bash
   echo '{"tool_name":"Bash","cwd":"<this worktree>","tool_input":{"command":"cd <main repo> && git worktree list 2>&1"}}' \
     | bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts
   ```

   Exit 0 / no deny for that one; and still a deny for
   `echo x > "<main repo>/notes.txt"`, which today passes silently.
3. The lived test: re-run the original `git worktree lock … 2>&1` from the main checkout.
4. `./equin build` (background) per the agent workflow.

## Notes

- No migration, no schema, no UI. The guards plugin is `core`-only.
- `>(…)` bodies becoming real calls means guards now see commands they previously did not — that is
  the intent, and `main-writes.test.ts` asserts it.
