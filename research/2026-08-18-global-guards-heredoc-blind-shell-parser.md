# The guards' shell parser has no heredoc model

**Date:** 2026-08-18
**Area:** `plugins/framework/plugins/tooling/plugins/guards/`

## Context

An agent writing a research doc was refused. The command was a plain
`cat > research/x.md <<'EOF' … EOF`; nothing was executed. The document's own
Verification section contained the lines

```
- `./equin build --composition sonata` from an agent worktree …
- `./equin build` with no flag is byte-equivalent …
```

and the background-ops guard denied the write, telling the agent to stop and ask
the user. A full round trip lost to a document that merely *talks about* a build.

### What is actually wrong

The report reads as "the guard matches on raw text". It doesn't — every Bash
guard already routes through the shared parser, `core/parse-shell.ts`. The real
defect is narrower and worse: **the parser has no heredoc model**, so the text
being *written* is parsed as shell.

Since `9b40c7ba1` ("newline-aware shell split") every `\n` is a command
separator, and `extractSubstitutions` lifts every backtick / `$( )` span out as a
command substitution. A heredoc body is neither — it is data the shell hands to
a process on stdin. Parsed anyway, a markdown document becomes a script.

Reproduced against the real parser on the doc above:

```
[ {n:"cat", a:["<<EOF"]},          ← the real call
  {n:"##", a:["Verification"]},
  {n:"-", a:["from","an","agent","worktree"]},
  {n:"singularity", a:["build","--composition","sonata"]},   ← phantom (backticks)
  {n:"singularity", a:["build"]},                            ← phantom (backticks)
  {n:"bash", a:[]},                                          ← a ```bash fence
  {n:"singularity", a:["build"]},                            ← phantom (code fence line)
  {n:"EOF", a:[]} ]
```

Two ways in, both routine in a markdown file: inline code in backticks, and a
line inside a fenced code block.

### Blast radius

This is not the background-ops guard's bug. Every Bash guard shares the parser,
so every one of them mis-reads documentation:

| guard | shape it matches | trips on a doc that mentions |
| --- | --- | --- |
| `background-ops` | `singularity build/push/check/test/release` | the build workflow |
| `git-push` | `git push` | the push rule |
| `git-reset-main` | `git reset origin/main` | the rebase rule |
| `git-diff-main` | `git diff main` | the review-diff rule |
| `find` | `find` without `-prune`/`-maxdepth` | the find footgun |
| `postgres` | `psql`, `pg_dump`, … | a DB debugging note |
| `migrations` | `rm …migrations/data/…` | the migrations rule |
| `main-writes` | a write resolving under the main checkout | any path example |
| `rg-replace` | `rg -rn`-style clusters | an `rg` example |

`core/poll-detect.ts` is exposed by a second, unrelated route: `watchSubjects()`
regexes the **raw** command for `build-status.json`, `logs/<x>.jsonl`,
`tasks/<id>.output`, `git ls-remote` and URLs. A doc naming those reads as the
agent watching them, which feeds the poll-loop guard's window.

### How often

Measured by replaying the eight side-effect-free Bash guards over 30 days of
recorded transcripts under `~/.claude/projects` (23 569 Bash calls, 1 309 denies):

- **889** commands carried a heredoc — 3.8% of all Bash calls, and the
  *recommended* way to write a file: this repo sets `defaultMode:
  bypassPermissions`, where the harness tells agents to prefer Bash heredocs over
  the Write tool.
- **314** of those are quoted-delimiter document writes — inert data, expanded by
  nothing. **8 of them are denied today, and all 8 are phantoms.** Owners across
  the corpus: `cat` 340, `python3` 246; `bash <<EOF` never appears.
- A prototype of the fix below removes exactly those 8 denials, keeps the other
  20 heredoc denials (all genuine — mostly a real foreground `push` on the
  operator's own line), and adds none.

The agent that hit this was writing a doc. The corpus also holds a `.ts` file
written by heredoc whose *source* contained `psql`, and — twice — an agent
debugging these very guards whose probe script tripped `git-push` and
`git-reset-main`.

### What is not wrong

The refusal epilogue ("STOP … do NOT work around this guard — not by
restructuring the command, not by using alternative tools") is correct policy for
a true positive, and softening it would be fixing the wrong rung. Once the parse
is right there is nothing to route around.

## The fix

Give the parser the heredoc model it is missing, in the one place every guard
already goes through. Data stops having a spelling as code.

### 1. A substitution-aware pre-pass, at the top of `collect()`

`splitHeredocs(text) → { code, docs }`, called at the **top of `collect()`**
(before `splitOnOperators`), so it applies to every recursed context — `$( )`
bodies, backticks, `( … )` groups — and not just the outermost string.

```ts
interface HeredocDoc {
  body: string;
  /** Unquoted delimiter: the shell expands `$( )` / backticks inside the body. */
  expanded: boolean;
  /** Offset in `code` where the operator was removed — attributes the body to its segment. */
  at: number;
}
```

The scanner walks the text carrying quote state, and **must carry a context
stack, not just a quote mode**: `$(` (valid in mode `none` *and* mode `double`)
and a backtick push the current mode and reset to `none`; the matching `)` /
closing backtick pops.

That stack is the load-bearing part, and the reason deserves a WHY-comment. The
most common heredoc in this repo is

```
./equin push -m "$(cat <<'EOF'
<commit message>
EOF
)"
```

where `<<` sits inside the double quote opened by `-m` — 118 of 879 corpus
commands look like that. A quote-mask-only scanner declines there, and the body
survives into `splitOnOperators`. It is tempting to argue that this is harmless
because `splitOnOperators` is paren-depth aware, so the whole `$( … )` stays one
segment, `extractSubstitutions` lifts the inner `cat <<'EOF' … EOF` out, and the
recursion strips it there. **That only holds while the body's `"` count is even.**
One unpaired quote in the prose flips the mode back to `none` mid-body and the
remaining lines split at depth 0 — verified against the real parser:

```
./equin push -m "$(cat <<'EOF'
He said "hi and ran `./equin build` then
next line with $(git push) here
EOF
)"
→ singularity[push,…] | singularity[build] | next[…] | git[push] | EOF[]
```

Those phantoms are minted before any recursion, so a scanner that declined at
depth 0 never sees them. With the context stack the body is removed at depth 0,
which also *repairs* the downstream quote tracking rather than working around it:
the body was never part of the token stream to begin with.

Delete the `\d*<<-?DELIM` operator text from `code` in the pre-pass itself, where
the exact offsets are known — not with a token-level rule in
`stripRedirections`, which would also eat a legitimate `<<`-leading argument
(`shellSplit` has already erased the quoting that distinguished them). Today
`cat > f <<'EOF'` yields `{name:"cat", args:["<<EOF"]}`; after the fix it yields
`{name:"cat", args:[], redirections:[{">", "f"}]}`.

### 2. Attribution and executability

`splitOnOperators` returns `{ text, end, sep }[]` instead of `string[]`, so each
segment carries its span; `collect` records, per segment, the calls it emitted
and the cwd in effect. Each doc is attached to the first segment whose span ends
past `doc.at`, and then:

- **The owner segment's calls include a shell interpreter** (`bash`, `sh`, `zsh`,
  `dash`, `ksh`) — **or the segment is piped into one that does** — parse the
  body as commands, with the owner's cwd. `bash <<'EOF'` really executes it,
  quoted delimiter or not, and so does `cat <<'EOF' … | bash`. Reading the
  segment's already-emitted calls gets wrappers and `VAR=` prefixes for free.
  The pipeline arm matters: without it the fix hands every Bash guard a one-line
  bypass, and the epilogue's "do not restructure the command" is exactly the
  pressure that would find it.
- **Otherwise, unquoted delimiter** — recurse only into the body's `$( )` /
  backticks, which genuinely expand. Extract them with a small quote-*blind*
  `bodySubstitutions()`, honouring only `\`: a heredoc body has no quoting, so
  reusing `extractSubstitutions` would let an apostrophe open a fake single-quoted
  region and hide `$(git push)` after every contraction.
- **Otherwise** (quoted delimiter, non-interpreter owner — 97% of real use) the
  body contributes nothing.

The recursion's return value is discarded, as for subshells: a `cd` inside a
heredoc body does not move the parent.

### 3. `ShellParseResult.code` — the executable text

Add `code: string` (the input minus heredoc bodies and their operators) beside
`calls` and `redirections`, and move the two raw-text readers onto it:

- `core/guards/background-ops.ts` — `shellDetachIn()`'s trailing-`&` test. A
  script being written whose last body line ends in `&` is not a detach.
- `core/poll-detect.ts` — `watchSubjects()` and `classify()`. Keep the exported
  `watchSubjects(cmd)` signature and add a `watchSubjectsFrom(parsed)` under it,
  so `poll-loop.ts`, `index.ts` and the e2e harness are untouched; have
  `classify` parse once and share it (it parses three times today, which more
  than pays for the pre-pass).

A body executed by an interpreter is deliberately *not* re-inserted into `code` —
its commands are in `calls`, but a `tail -f logs/x.jsonl` inside `bash <<'EOF'`
loses its watch subject. Say so in the field's doc-comment rather than
complicating the pre-pass.

## Traps — each one is a test, and most are under-detection

These are the ways a careless pre-pass makes the guards *weaker*, which is far
worse than the bug being fixed.

- **`<<<` is a here-string.** A character-walking scanner reaches the second `<`
  of `<<<`, sees `<<` followed by a word, and swallows every following line as a
  body — blinding every guard after it. Consume all three characters.
- **Delimiter grammar.** Require `'W'` / `"W"` / `\W` / bare
  `[A-Za-z_][\w.-]*` (`<<\EOF` is quoted semantics). Rejecting numeric and
  punctuation delimiters keeps `$((1 << 2))` from starting a body.
- **Arithmetic with a variable operand.** `$((x << shift))` *does* match the
  delimiter grammar. On `$((`, copy verbatim to the matching `))`.
- **Comments.** `# see <<EOF for details` would swallow the rest of the script.
  Skip `#` at a word boundary to end of line — inside the pre-pass only; general
  comment handling in the parser is a separate change with its own regressions.
- **Terminator matching must err lax, never strict.** Compare `line.trim() ===
  delim` (terminating earlier than bash is the safe direction), strip leading
  tabs on body and terminator for `<<-`, tolerate a trailing `\r`. Unterminated
  runs to end of input.
- **Multiple operators on one line** consume their bodies in operator order
  (verified against bash).
- **cwd attribution.** `cd sub && bash <<'EOF' / rm -rf . / EOF` — body calls must
  carry the owner segment's cwd, or `main-writes` resolves the target against the
  wrong directory and misses it. This is why attachment is positional rather than
  "process the docs at the end".
- **Non-shell interpreters stay blind, on purpose.** `python3 - <<'PY'` bodies
  stop being parsed. In the corpus that removes two accidental denials, and it
  makes the blind spot consistent rather than lucky — `python3 -c
  "os.system('git push')"` is equally invisible today. Document it; the `>` on
  the operator's own line is still scanned, so `python3 <<'PY' > /main/file`
  remains caught.

## Files

- `.../guards/core/parse-shell.ts` — the fix (`splitHeredocs`, `bodySubstitutions`,
  `SHELL_INTERPRETERS`, `splitOnOperators` shape, `collect` attribution, `code`).
- `.../guards/core/parse-shell.test.ts` — the matrix below.
- `.../guards/core/guards/background-ops.ts` + `.test.ts` — `code`-based detach test.
- `.../guards/core/poll-detect.ts` — `watchSubjectsFrom`.
- `.../guards/e2e/replay-transcripts.ts` — the `--guards` mode.

**Sequencing.** (1) `splitHeredocs` + its tests as a pure function, no consumers;
(2) wire into `collect`, including the `splitOnOperators` shape change and doc
attribution; (3) expose `code`, route the two readers; (4) the replay mode. Every
regression lives in 1–2; 3–4 are mechanical.

## Tests

`bun:test`, run with `./equin test plugins/framework/plugins/tooling/plugins/guards`.
The existing `names(cmd)` / `blocks(guard, cmd)` helpers in `parse-shell.test.ts`
cover all of it.

Body is data:

- The repro: a doc write whose body has the build command in backticks, and again
  in a ```` ```bash ```` fence → `names` is `["cat"]`, the `>` redirection is
  still seen, and the `<<EOF` argument is gone.
- `<<-EOF` with a tab-indented body and terminator; two heredocs on one line;
  unterminated heredoc; a body with an unbalanced quote or paren followed by a
  real command after the terminator (which must survive).
- `parseShell(…).code` contains neither the body nor the operator.

Nothing hidden by it:

- `./equin push -m "$(cat <<'EOF' … EOF)"` — the push is still denied in
  the foreground, allowed with `run_in_background`. **And the same with an
  unpaired `"` in the message body** — the depth-0 case above.
- `bash <<'EOF'` with `git push` in the body; `cat <<'EOF' … | bash` likewise.
- Unquoted `<<EOF` whose body has `$(git push)`, and one where it follows an
  apostrophe (`it's $(git push)`).
- `rg foo <<< "$x"` followed by `git push`; `n=$((1 << shift)); git push`;
  `# see <<EOF here` followed by `git push`.
- `cd sub && bash <<'EOF' / rm -rf .` — the `rm` call's cwd is `/base/sub`.
- `./equin build &` still denied; `./equin build 2>&1` with
  `run_in_background` still allowed.
- `python3 - <<'PY' … PY` followed by `./equin check …` — still denied,
  which proves the scanner resumes after a terminator.

## Verification

1. `./equin test plugins/framework/plugins/tooling/plugins/guards`
2. `./equin check`
3. `bun .../guards/e2e/replay-transcripts.ts --guards --assert` (below).
4. End-to-end against the live hook, which is what actually failed: write a doc by
   heredoc whose body contains the build command in backticks and in a fence, and
   confirm the call is allowed and the file lands. Then confirm a foreground
   build is still denied.
5. Guards are a hook, not app code — no `./equin build` is needed for the
   fix to take effect; `bin/guard.ts` re-reads the source per tool call.

## The replay mode

`e2e/replay-transcripts.ts` already exists to *measure* the poll rule against
recorded transcripts rather than assert it. This change alters the input of every
Bash guard at once, and a replay is the only instrument that can say whether it
blinded any of them — so it belongs in scope, as step 4.

Add `--guards` to the existing script, reusing its corpus walk and tool-call
reader, keeping the poll report as the default mode. Replay only the eight
side-effect-free guards; exclude `poll-loop` (writes tmpdir state, and is the
default mode's job) and `git-diff-main` (writes a `.git-diff-main-reminded`
marker), with a comment saying why. Build each `GuardContext` from the
transcript entry's **own `cwd`** — a sibling worktree looks like main otherwise,
and `main-writes` mis-reports.

Report total denies, denies per guard, denies among commands containing `<<`, and
denies among quoted-delimiter document writes — plus, under `--verbose`, those
document-write denials, which are the false positives. Under `--assert`:

- `DOC_WRITE_DENIES_CEILING = 0` — **a hard zero, not a floor-style estimate.**
  This is the invariant the change installs: writing a document is never a denied
  command. Measured today: 8 of 314. It does not drift with the corpus, which
  makes it the one assertion worth being strict about.
- `FLOOR_BASH_DENIES = 1000` (measured 1 309) — catches the opposite failure, a
  pre-pass that swallows real commands.
- `FLOOR_HEREDOC_DENIES = 10` (measured 28 before, 20 after) — the genuine
  foreground-`push` denials that must survive; a collapse to 0 means heredoc
  commands stopped being parsed at all.
- Print newly-added denials explicitly. The prototype's was 0; that is the number
  a reviewer re-checks after any tweak to the delimiter grammar.

## Optional add-on

A **lint rule** in the guards plugin's `lint/` forbidding a guard from regexing
`input.command` directly — every read goes through `parseShell`'s calls or its
`code`. Rung 3, so a future guard cannot re-introduce data-as-code. Both existing
call sites are fixed above, so the rule would land clean. Not required to close
the bug.
