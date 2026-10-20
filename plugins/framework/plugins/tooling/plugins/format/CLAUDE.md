# format

The repo's **byte-format authority**. One module decides what may be formatted,
with which options, and over which files — so the writer (`./singularity build`,
`./singularity format`) and the readers (the `*-in-sync` checks, `format-clean`)
cannot produce different bytes.

Design docs:
[`research/2026-08-06-global-prettier-auto-format.md`](../../../../../../research/2026-08-06-global-prettier-auto-format.md)
(the seam) and
[`research/2026-08-17-global-format-seam-named-arguments.md`](../../../../../../research/2026-08-17-global-format-seam-named-arguments.md)
(why its arguments are named).

## Path and content are NEVER positional

Every function here takes ONE named object — `{ file, content }`,
`{ file, before, after }` — as do codegen's `formatGenerated` / `writeGenerated`
across the seam. Hard rule for anything added, not a style preference: as two
adjacent unlabelled strings, `formatSource(source, file)` type-checked, ran no
prettier, and returned the PATH as formatted source. It destroyed 44 files
silently on 2026-08-17. `writeGenerated` needs it most — it writes, so a slip
created a file named after its own content.

The bytes are `content` everywhere (one name per concept), not `source`, which
would be false for the `.md` / `.jsonc` / `.css` this seam also carries.

## Why `core/` and not `server/`

The check runner reaches **core barrels only** (`core → core` runtime
isolation), and `format-clean` must share this exact implementation with the
build. `core/` here means runtime-neutral Node, not web-safe: it reaches
`node:fs` / `node:path` and spawns git. Never import it from `web/`.

## The allowlist is unbypassable

`FORMATTABLE_EXTENSIONS` is `.ts`, `.tsx`, `.mts`, `.cts`. **Markdown must never
be added.** JSON/JSONC is deliberately deferred.

The API makes the allowlist impossible to route around: both entry points take a
**file path**, there is no `parser` parameter, and there is no content-only
entry point. So a caller cannot format a `.md` by calling it anyway.

**Two entry points, because "held out" and "garbage" must not share a return
value.** `formatSource` THROWS on a non-formattable path.
`formatIfFormattable` returns the content unchanged (without even loading
prettier), and has exactly ONE caller: codegen's `formatGenerated`, whose file
set legitimately spans `.md`, `.jsonc`, `app.css` and held-out
`*.generated.ts`. Don't reach for it elsewhere — when the pass-through was the
only behavior, a swapped argument was indistinguishable from a legitimate one.
Both also reject a `file` that cannot be a path (empty, newline, absurdly long),
which is the only rung an untyped ad-hoc script gets.

**`FORMATTABLE_EXTENSIONS` is a pure extension list; `isFormattable` is not.**
The predicate answers "will this file actually be formatted?", which is the
question both callers ask, so it additionally holds out `*.generated.ts` while
`FORMAT_GENERATED_ARTIFACTS` is `false`. Don't conflate the two.

## Generated artifacts are held out by ONE predicate

`FORMAT_GENERATED_ARTIFACTS` (currently `false`) lives here and nowhere else,
and `isFormattable` consults it. Two writers reach `*.generated.ts` — codegen's
`formatGenerated`, and the build's changed-set pass, which sees them as ordinary
changed `.ts` — so a second copy of the switch lets them disagree. The symptom
is a deterministic ping-pong: codegen writes the file, the format pass (which
runs after all codegen) rewrites it, no build is idempotent, and every
`*-in-sync` check over a generated file goes red.

Flipping it is a deliberate, isolated, revertible commit of its own: at default
width `web.generated.ts` goes 783 → 10,150 lines (design doc's open decision).
One flip covers both writers — they both consult `isFormattable`.

## Config is hardcoded, not resolved

`prettier.resolveConfig()` is never called and `.prettierignore` is not honored.
The options are a literal object of prettier's own defaults, spelled out so a
prettier upgrade that changes a default cannot silently reformat the repo. A
per-file config walk would be a way for the writer and the checkers to diverge,
and byte-identity between them is the whole point.

The root `.prettierrc` exists **only so editors agree**; its header says so. If
the two ever disagree, the options object wins and `.prettierrc` is the bug.

## The prettier import is dynamic and memoized

`let mod; mod ??= import("prettier")`. Dynamic is load-bearing, not style: a
static import hoists above every statement, so one reachable from the CLI would
resolve out of the very `node_modules` that `ensureDeps()` exists to repair —
the same hazard `cli:bootstrap-package-free` enforces against on `bin/index.ts`.
Lazy also means a build whose changed set has no `.ts` pays nothing.

The paired `format-safety/no-adhoc-prettier` lint rule bans importing or
spawning prettier anywhere else, which is what keeps that guarantee true.

## The changed set is computed once

`listChangedFormattableFiles(root)` is the single implementation. If build and
`format-clean` computed different sets, the build would format one and the check
would assert another. It is `git merge-base HEAD main` (a failure **throws** — a
manufactured fallback ref would silently format nothing), then
`git diff -M -z --name-status --diff-filter=ACMR <base>` (the base against the
working tree: committed, staged and unstaged alike), plus the untracked files
from `git status --porcelain -z --untracked-files=all`, filtered by
`isFormattable`, sorted. Each file carries its **scope**: `lines` with its bytes
at the base (its rename origin's), or `file` when the base has no such file
(added, untracked) or it is a coupled-set member.

On `main` the merge-base is HEAD, so the set is just dirty + untracked files.

## Only the lines a branch changed are formatted

`formatInScope` (`core/internal/line-scope.ts`) decides the bytes for every
writer and reader: prettier formats the WHOLE file (it needs the whole program;
`rangeStart`/`rangeEnd` widens unpredictably), then only the hunks of
`content → formatted` that overlap a line the branch changed against the base
are applied (the `darker` / `git-clang-format` shape), repeated to a fixed
point. A one-for-one run of rewritten lines is split into per-line hunks, so an
edit never drags in its untouched neighbours; a hunk that joins or splits lines
stays whole.

**Why:** prettier is not pinned (`^3`), so its output moves with its releases.
Formatting whole files would turn every one-line edit after a prettier upgrade
into a whole-file reformat — review noise and merge conflicts with every other
branch touching the file. Line scope makes an upgrade cost nothing: lines nobody
touches keep their bytes, and lines someone touches get the current prettier.
The repo is therefore NOT fully prettier-formatted at any moment, by design.

**Writer and readers agree by construction.** `formatInScope` is a pure
function of `(content, base)` and stops at its fixed point, so a file the build
left as `X` is one where `format-clean`'s `formatInScope(X)` is `X`. Two
endings settle on the whole-file answer instead, which is equally reproducible:
a file that has not converged after 8 rounds, and a partial selection that is
not a formatting: one prettier cannot parse (`FormatSyntaxError` — a reflow
split across hunks), or one whose prettier output differs from the original's
(`format(selection) !== format(content)` — the line diff split one edit into an
insertion and a deletion and only the deletion was selected, which once deleted
a used `import {…}` block outright). A syntax error in the content itself still
throws.

## Coupled sets

`COUPLED_FORMAT_SETS` expresses "touching one of these drags in all of them".
**Empty today** — its one member (six lint rules a check held byte-identical)
now shares one injected walk, so there are no copies to hold together.

Add a set whenever a check byte-compares files: formatting one alone would break
it, and the failure reads as mystifying on a branch that only ran a formatter.

## Writing is guarded twice

`formatChangedSources` writes **only on byte difference** (web artifacts
fingerprint on `(mtimeMs, size)`; an unconditional write would invalidate an
artifact whose bytes never changed) and **re-reads immediately before writing**,
skipping with a log line if the bytes moved since the initial read. The build
lock serializes builds, not the agent's editor — an edit landing mid-pass would
otherwise be clobbered.

## Formatting may not move a positional lint directive

`// eslint-disable-next-line R` binds to a line NUMBER, not to the code it
means; prettier reflows lines. `formatChangedSources` therefore compares each
directive's target before and after formatting and **refuses to write** a file
whose directives would change what they suppress, throwing once at the end of
the pass with every offender named.

This is the primary defense, not the paired
[`lint-directives-stable`](../checks/plugins/lint-directives-stable/CLAUDE.md)
check, and the reason is worth keeping: this is the only place in the repo that
holds a file's pre- AND post-format bytes. Write them and the evidence is gone —
a widened directive then silently suppresses violations nobody vetted, and every
later gate, that check included, is structurally green. The check is the
`push` surface (push never builds); both print the same
`formatDirectiveDisplacementReport`.

The comparison is structural: same target iff the same sequence of AST nodes
*starts* on the line — which is what ESLint actually suppresses. So quote
normalization, added trailing commas and reindentation are correctly not
displacements. Comments come from the parsed token tree, never a raw
`ts.createScanner` loop, which desyncs on regex literals and invents directives
out of `//` inside strings.

Each leaf's trivia run is scanned from **both** ends — leading *and* trailing
comment ranges. Not redundancy: `getLeadingCommentRanges` starts collecting only
after the run's first line break and `getTrailingCommentRanges` stops at it, so
leading alone silently misses every same-line directive — the braced JSX form
(~19% of the repo's) and every trailing `eslint-disable-line`.

## Failures are loud

A prettier syntax error throws, re-stamped with the path. Do not swallow and
skip: a silently skipped file lands unformatted and `format-clean` then fails at
push with no explanation. Partial progress needs no rollback — formatting is
idempotent and per-file.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The repo's byte-format authority: the prettier allowlist, the hardcoded options, and the merge-base changed-file set that build / format / format-clean all share.
- Core:
  - Uses:
    - `infra/spawn.spawnCaptured`
    - `packages/macrotask-yield.createTimeSlicer`
  - Exports (types):
    - `DirectiveDisplacement`
    - `DirectiveTarget`
    - `SourceBytes`
  - Exports (values):
    - `findDirectiveDisplacements`
    - `findDisplacedDirectives`
    - `findUnformatted`
    - `formatChangedSources`
    - `formatDirectiveDisplacementReport`
    - `formatIfFormattable`
    - `formatSource`
    - `FORMATTABLE_EXTENSIONS`
    - `isFormattable`
    - `listChangedFormattableFiles`
- Cross-plugin:
  - Imported by: `framework/tooling/codegen`
- Exemptions:
  - Exempts itself from:
    - `format-safety/no-adhoc-prettier` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `core/internal/changed-files.ts`, `core/internal/format-sources.ts`, `core/internal/format-thread.ts`, `core/internal/format-worker.ts`, `core/internal/prettier.ts` (debt)

<!-- AUTOGENERATED:END -->
