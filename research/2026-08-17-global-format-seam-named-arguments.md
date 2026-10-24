# The byte-format seam takes named arguments, and refuses garbage loudly

Date: 2026-08-17
Category: global (tooling/format, tooling/codegen, tooling/checks)

## Context

`formatSource(file: string, source: string)` takes two adjacent, unlabelled
strings. Called as `formatSource(source, file)` it type-checks, does not throw,
and returns the **file path** as if it were formatted source: `isFormattable`
tests the source TEXT for a formattable extension, returns false, and the
function early-returns its second argument — which is the path. Prettier never
runs. A caller that writes the result back replaces the file's whole contents
with its own path.

On 2026-08-17 this destroyed 44 `.ts` files in a worktree. An agent
pre-formatting its changed files enumerated `git status --porcelain`, filtered
to `.ts`, called `formatSource(src, f)`, and wrote each result back. Every
affected file became the 40–70 byte string of its own path with no trailing
newline. No error, no exception, no signal of any kind; the damage surfaced
later through an unrelated import error, and the four untracked files among them
were unrecoverable.

Two things made it silent, and both are fixed here:

1. **The order is spellable.** Two adjacent `string` parameters mean a slip
   type-checks.
2. **The identity return is overloaded.** "this file type is not formattable"
   and "the caller handed me garbage" come back as the same value, so misuse is
   indistinguishable from a legitimate pass-through.

The same two-adjacent-strings shape is on three siblings in the same seam —
`formatGenerated`, `writeGenerated` (which **writes**, so its swap creates a
file named after its own content), and `findDirectiveDisplacements(file,
before, after)` (whose swap silently inverts the report that exists to *stop* a
bad write). Per the Coding Style ladder we fix the class, not the instance.

Background on the seam itself:
[`research/2026-08-06-global-prettier-auto-format.md`](2026-08-06-global-prettier-auto-format.md)
and
[`plugins/framework/plugins/tooling/plugins/format/CLAUDE.md`](../plugins/framework/plugins/tooling/plugins/format/CLAUDE.md).

## The end state

```ts
// format/core
await formatSource({ file: rel, content });          // THROWS unless formattable
await formatIfFormattable({ file, content });        // identity for held-out paths
await findDirectiveDisplacements({ file, before, after });

// codegen/core
await formatGenerated({ file, content: renderX(root) });
await writeGenerated({ file: pluginClaudeMdPath(root, id), content });
```

and the incident's call is now three separate failures instead of zero:

```ts
formatSource(src, f)
//           ^ tsc: Expected 1 arguments, but got 2

formatSource({ file: src, content: f })
// Error: formatSource: "file" is not a path — it contains a newline.
//        Arguments swapped? The shape is { file, content }.
```

## Design

### 1. One named-argument object per function — rung 1, the order has no spelling

Every function in the seam takes a single object. This is not ergonomics: with
`{ file, content }` there is no adjacent-slip to make. Producing the bug now
requires naming both fields wrongly, which is a lie rather than a slip.

`content` is the ONE name for the bytes across all five functions. Not `source`:
the seam's file set spans `.md`, `.jsonc` and `.css` as well as `.ts`, so
`source` would be false for most of it. `formatSource` keeps its own name — it
is the format plugin's public identity and renaming it buys no safety.

### 2. Split the assertive format from the deliberate pass-through — rung 4 for the residue

`formatSource` currently means both "format this" and "format this if you feel
like it". Split them:

- **`formatSource({ file, content })`** — THROWS when `!isFormattable(file)`.
  The message names the allowlist and points at the other function.
- **`formatIfFormattable({ file, content })`** — returns `content` unchanged for
  a held-out path, otherwise delegates to `formatSource`.

The permissive arm is genuinely load-bearing, which is why it stays and gets a
name of its own rather than being deleted. Its ONE caller is codegen's
`formatGenerated`, whose file set legitimately contains non-formattable paths
for two distinct reasons:

- **extension not on the allowlist** — `docs/plugins-compact.md`,
  `docs/plugins-details.md`, every plugin `CLAUDE.md` (docgen), every
  `*.origin.jsonc` and authored-override `.jsonc` (config origins),
  and `app.css`.
- **`*.generated.ts`, held out while `FORMAT_GENERATED_ARTIFACTS` is `false`** —
  the registry / manifest artifacts, the majority of sites.

Everything else — all three call sites in `format-sources.ts` — iterates
`listChangedFormattableFiles`, which has already filtered by `isFormattable`, so
it takes the throwing arm and would be loud if that ever stopped being true.

### 3. Reject a `file` that cannot be a path — rung 4, and the only rung untyped callers get

A shared private `assertPathArg(fn, file)` runs at the top of both entry points:
non-empty, no `\n` / `\r` / `\0`, length ≤ 4096. Its message names the swap.

This is the rung that matters for how the incident actually happened — an
ad-hoc script, run outside `tsc`, where named arguments are a convention rather
than a constraint. Real source text has newlines, so a swapped call trips it
before anything can be returned. The extension throw from §2 catches the same
swap from typed code; the newline check closes the residual case where a blob of
source text happens to end in something `extname` reads as `.ts`.

`isFormattable` deliberately does **not** assert. It is a filter predicate
(`files.filter(isFormattable)`) over git-enumerated paths, `false` is a
legitimate answer for it, and making it throw would make the enumeration
non-total for no gain.

### 4. Rejected alternatives

- **A branded `SourcePath` type.** Pushes a cast to 30+ call sites, and the mint
  point just becomes the new unchecked place. The named object already removes
  the order slip at zero call-site cost.
- **A lint rule banning adjacent `(a: string, b: string)` parameters
  repo-wide.** Unbounded false positives for a defect this seam-specific.
- **Un-exporting `formatSource`.** Codegen legitimately needs the pure function.
- **Deleting the pass-through entirely.** Six call-site families depend on it;
  see §2.

## Files

| File | Change |
| --- | --- |
| `format/core/internal/prettier.ts` | `formatSource` → object arg + throw; add `formatIfFormattable` and private `assertPathArg` |
| `format/core/internal/format-sources.ts` | 3 `formatSource` + 2 `findDirectiveDisplacements` call sites |
| `format/core/internal/directive-displacement.ts` | `findDirectiveDisplacements` → `{ file, before, after }` |
| `format/core/index.ts` | export `formatIfFormattable` |
| `codegen/core/write-generated.ts` | both signatures → object arg; `formatGenerated` delegates to `formatIfFormattable` |
| `codegen/core/*-gen.ts`, `docgen.ts`, `pre-barrel-*.ts` | 16 `writeGenerated` + 1 `formatGenerated` call sites — mechanical |
| `checks/plugins/*-in-sync/check/index.ts` (12 files) | 13 `formatGenerated` call sites — mechanical |

Paths are under `plugins/framework/plugins/tooling/plugins/`. Order the work
top-down: change the two signature files first and let `tsc` enumerate the rest
— every remaining site is a compile error, so none can be missed.

Two touched call sites are worth reading rather than pattern-matching:
`checks/plugins/config-origins-in-sync/check/index.ts:84` (its `file` local is
`filePath`) and `checks/plugins/plugins-doc-in-sync/check/index.ts:44,54` (two
different path variables in one expression).

## Tests

New `format/core/internal/prettier.test.ts`, colocated `bun:test` per the
`test-layout:runner-split` convention (see
`codegen/core/config-origin-gen.test.ts` for the shape). The seam has no direct
test today.

- `formatSource` formats a `.ts` and is idempotent on its own output.
- `formatSource` throws for `README.md`, `x.jsonc`, `app.css`, `x.generated.ts`.
- **The incident, verbatim**: `formatSource({ file: <multi-line ts source>,
  content: "a.ts" })` throws, and the message mentions swapped arguments.
- `formatIfFormattable` returns content byte-identical for each held-out kind,
  and formats a plain `.ts`.
- `formatIfFormattable` still trips `assertPathArg` on a newline-bearing `file`.

```bash
./equin test plugins/framework/plugins/tooling/plugins/format
```

## Verification

1. `./equin check type-check` — the compile errors are the migration's
   own checklist; green means every call site moved.
2. `./equin test plugins/framework/plugins/tooling/plugins/format`
3. `./equin build` (background, per the agent workflow) — this is the real
   end-to-end: codegen re-emits every generated artifact through the new
   `writeGenerated`, and the changed-set pass formats this branch's own diff
   through the new `formatSource`.
4. `git status` / `git diff --stat` after the build: the only changes are the
   intended edits plus regenerated doc blocks. **No `.generated.ts`, `.md` or
   `.jsonc` artifact may change content** — if one does, the pass-through split
   put a file on the wrong arm. Spot-check that no file's contents equal its own
   path.
5. `./equin check` — all 13 `*-in-sync` checks re-run their comparison
   through the new `formatGenerated`, which is the broadest available proof that
   the emit side and the check side still agree byte-for-byte.

## Docs

`format/CLAUDE.md` — rewrite "The allowlist is unbypassable" (the claim now
rests on named arguments plus the throw, not on the identity return), and add a
short section stating the seam's rule: **a function in this seam never takes a
path and a content as positional arguments**, so the next one added inherits the
constraint. The autogen reference blocks in `format/CLAUDE.md` and
`codegen/CLAUDE.md` regenerate on build.
