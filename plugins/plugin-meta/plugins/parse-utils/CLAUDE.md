# parse-utils

Shared, dependency-light helpers for **scanning TypeScript source at build time**
(codegen, facets, checks, the boundary checker). The repo deliberately has no TS
AST in this path — everything is regex + bracket-matching over text.

## Source scanning MUST ignore comments / strings / regex literals

A scanner that matches a marker against *raw* source treats an occurrence inside
a comment, string literal, or regex literal as real code. That is a silent
correctness bug (it once made codegen emit a phantom `<dir>.generated.ts` from a
`defineCollectedDir("…")` written in a comment, which broke `tsc`). **Never**
`readFileSync`-and-regex or bare `git grep` for a marker. A hand-rolled global
`const <name> = <call>(` binding scan over raw source is the fully-unmasked twin
of the `{ strings: false }` trap and is banned by the `no-adhoc-binding-scan`
lint rule (in `framework/tooling/lint/plugins/marker-scan-safety`) — route it
through `markerCallSpans(maskSource(src), …)` and read the binding name + string
value back from the original by offset. Route through one of:

- **`findImports(src)`** — the single static-import scanner: every
  `import … from "…"`, `export … from "…"`, and bare `import "…"` not in a
  comment/string/regex. Returns `ImportRef[]` (`specifier`, `index`, `keyword`,
  `clause`, `typeOnly`, `sideEffect`). It masks strings FULLY and reads each
  specifier back by offset, so an import written *inside* a string/template
  literal (a test fixture, docs snippet, codegen template) can never be mistaken
  for a real import. **Always scan static imports with this — never hand-roll an
  `import … from "…"` regex** (enforced by the `no-adhoc-import-scan` lint rule).
  Dynamic `import()` / `require()` are calls, not static imports, and are out of
  scope — mask fully with `maskSource(src)` and read the quote span by offset.
- **`maskSource(src, { strings })`** — returns a same-length copy (offsets +
  newlines preserved 1:1) with comments, regex literals, and — when
  `strings !== false` (default `true`) — string interiors blanked to spaces.
  Run your detection regex on the masked text, then read real values from the
  *original* at the matched offset. A **marker-value scan** — reading the string
  argument of a real `defineX(...)` call (a slot id, a route URL, a model id) —
  MUST FULL-mask and read the value from the original by offset: use
  `findMarkerCalls(src, "defineX")`, or `markerCallSpans(maskSource(src), …)`
  when you also need the surrounding context (a preceding member/group name).
  Full masking is what makes it string-embedding-safe — a `defineX("id")`
  written inside a string/template literal (a test fixture, docs snippet,
  codegen template) is blanked away and never matched, while a real call's
  blanked id is recovered from the original. **Do NOT use `{ strings: false }`
  for this**, even with `markerCallSpans`: the span scanner matches the call
  against the text it is *given*, so a strings-kept mask surfaces a
  string-embedded call as a real one — exactly the trap the `no-adhoc-marker-scan`
  lint rule now forbids. `{ strings: false }` is reserved ONLY for a genuine
  **token-in-string scan** — a token that legitimately lives inside a string and
  has NO enclosing marker call (an `/api/…` URL or MIME string a caller passes to
  `fetch(...)`, e.g. `grepCode({ maskStrings: false })`); such a scan must be
  allowlisted in `no-adhoc-marker-scan`. Never use `{ strings: false }` for
  import scanning (use `findImports`) or a *code-construct* detector
  (`export default`, `new WebSocket(`, `x as T`, `defineX(`), which mask strings
  too so the construct can't match inside a string.
- **`markerCallSpans(masked, "defineX")`** — byte spans of every genuine
  `defineX[<…>](…)` call in already-masked source; the `<…>`-tolerant scanner
  every marker-value scan routes through. Pass a FULL mask (`maskSource(src)`) to
  be string-embedding-safe — a strings-kept mask surfaces a string-embedded call.
- **`findMarkerCalls(src, "defineX")`** — every genuine `defineX(...)` call not in
  a comment/string/regex; returns `{ index, argsText }` (args sliced from the
  original) to parse with `parseStringField` / `parseBoolField` / `matchBracket`.
- For `git grep`-style checks, use **`grepCode`** (line-oriented) or
  **`grepImports`** (import-specifier scanner, `findImports`-backed) from
  `@plugins/framework/plugins/tooling/plugins/checks/core` (git grep narrows
  candidate files, then `maskSource` + re-scan / `findImports` yields real-code
  matches only).

`maskSource` supersedes the old per-scanner skip-loops (the boundary checker's
private `stripComments`, and the inline logic in `matchBracket`).

## Never recover a source value by re-parsing transpiler output

Reading a field's value off `stripTypes(src)` (a Bun transpile) is a latent
data-loss bug. Bun's transpiler **re-quotes** string literals: a
`"…\"…\"…"` re-emits single-quoted, a literal mixing both quote kinds re-emits
as a backtick, and a literal with a `\n` re-emits with a real newline inside a
backtick. Any regex over that transpiled text silently loses or corrupts the
value (the reported bug: a `description` containing a `"` vanished from every
generated doc). **Mask the ORIGINAL source and read the value back by offset** —
`maskSource` keeps quote delimiters verbatim and preserves offsets 1:1, so the
masked text tells you *where* a literal starts and the original supplies its
exact bytes. The readers below are the sanctioned home for this idiom.

**`stripTypes(src, path?)` — pass `path` whenever the source can be a `.tsx` file.**
The loader is picked by extension; the `ts` loader treats the first JSX tag as a
syntax error and throws a Bun `BuildMessage`, which is neither a `SyntaxError` nor a
`TypeError` and so **escapes `stripTypes`' own raw-source fallback and crashes the
caller**. Omitting `path` keeps the `ts` loader — correct only for `.ts`-only scans
(barrels, `core/`, `shared/`, schema files). Any scan that walks a `web/` tree sees
`.tsx` and must pass the path.

## String / boolean field readers

- **`readStringLiteral(src, at): StringLiteralResult`** — reads the string
  literal beginning at offset `at` in ORIGINAL (unmasked) source. Handles all
  three quote forms (`"` `'` `` ` ``) and cooks escapes
  (`\n \r \t \b \f \v \0 \\ \' \" \` `, `\xHH`, `\uHHHH`, `\u{…}`, line
  continuation; any other escaped char → the char itself). A backtick with an
  unescaped `${` → `{kind:"dynamic"}`; an otherwise-static backtick gets the
  prose whitespace-collapse (`\s+` → single space, trimmed) — an affordance for
  author-written backticks ONLY, never for a `"`/`'` literal. Result union:
  `{kind:"value",value,end}` (`end` = index just past the closing quote) |
  `{kind:"dynamic",expr}` | `{kind:"none"}` (not a quote char). Unterminated →
  `dynamic` (never hangs, never throws).

- **`readStaticCallId(original, span): string | null`** — the leading string-literal
  argument of a marker call (a slot id, a route URL, …), read from the ORIGINAL at
  the span returned by `markerCallSpans`. `null` when that argument is **not a
  static literal** — an identifier, a call, or an *interpolated* template such as
  `` `${id}.section` `` inside a factory. **Always read a marker call's id through
  this, never a hand-rolled quote regex.** The obvious pattern
  ``/^\s*"([^"]+)"|^\s*'([^']+)'|^\s*`([^`]+)`/`` looks right but silently captures
  a template's *interior*, handing back the literal text `${id}.section` as if it
  were a real id — a phantom that then owns a real registry key downstream (the
  reported bug: a factory's dynamic slot id claimed ownership of the generic slot
  group `Section` in the closure graph's first-writer-wins `groupOwner` map).
  `readStaticCallId` routes through `readStringLiteral`, which already classifies
  an interpolated backtick as `dynamic`, so the phantom is impossible by construction.

- **`parseStringField(src, field, opts?): StringFieldResult`** — masks
  INTERNALLY (safe on a raw buffer — a `field:` in a comment or string is never
  matched), locates the key, then reads the literal from the ORIGINAL by offset.
  The result is a discriminated union, NOT `string | undefined`: `{kind:"value"}`
  | `{kind:"absent"}` (no such key in real code) | `{kind:"dynamic",expr}` (key
  present but the value is an identifier / call / concat / interpolated template —
  a parse failure that must be handled, not silently absorbed as "no value").
  `opts.depth0: true` treats `src` as an object body and matches only top-level
  keys (nested `{}`/`[]`/`()` skipped via `matchBracket`), so a nested
  contribution's `description:` can't shadow the barrel's own.

- **`parseBoolField(src, field, opts?): boolean`** — same masking + `depth0`
  scoping. A boolean field's only valid literal forms are the bare `true`/`false`
  tokens, so the return stays a plain `boolean`.

- **`defaultExportObjectBody(src): DefaultExportObject`** — masks, finds
  `export default` as real code, and — only if the next non-space char is `{` —
  `matchBracket`es to its close, returning `{kind:"object",body}` (text strictly
  between the braces, sliced from the ORIGINAL) or `{kind:"absent"}`. The union
  is deliberate: `export default {}` is a legitimate EMPTY body, distinct from
  `absent`; a `string | null` return would let `if (!body)` conflate the two.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Core:
  - Uses:
    - `framework/plugin-id.isTestCodePath`
    - `framework/plugin-id.TESTING_FOLDER`
    - `framework/plugin-id.TESTS_DIR`
  - Exports (types):
    - `BarrelExport`
    - `DefaultExportObject`
    - `FsSnapshot`
    - `ImportRef`
    - `MarkerCall`
    - `MarkerCallSpan`
    - `StaticCallIdResult`
    - `StringFieldResult`
    - `StringLiteralResult`
  - Exports (values):
    - `defaultExportObjectBody`
    - `findImports`
    - `findMarkerCalls`
    - `lineAt`
    - `markerCallSpans`
    - `maskSource`
    - `matchBracket`
    - `parseBarrelExports`
    - `parseBoolField`
    - `parseDefineGroup`
    - `parseStaticCallId`
    - `parseStringField`
    - `readIfExists`
    - `readStaticCallId`
    - `readStringLiteral`
    - `runWithFsSnapshot`
    - `stripTypes`
    - `unresolvableCallIdMessage`
    - `walkFiles`
    - `walkFilesAsync`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `framework/tooling/boundaries`
    - `framework/tooling/checks`
    - `framework/tooling/codegen`
    - `framework/tooling/resource-vocabulary`
    - `framework/tooling/test-layout`
    - `plugin-meta/plugin-refs`
    - `plugin-meta/plugin-tree`
- Exemptions:
  - Exempts itself from: `import-scan-safety/no-adhoc-import-scan` — `core/find-imports.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
