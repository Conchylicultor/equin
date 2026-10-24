# Close the marker-id scanner string-embedding false-positive class

## Context

The **import-scanner** string-embedding false-positive class was recently closed
(commit `f40e9708e`): static-import scanning now routes through `findImports`,
which masks strings *fully* and reads each specifier back by offset, so an
`import … from "…"` written inside a string/template literal (a test fixture, a
docs snippet, a codegen template) can never be reported as a real import. A new
`no-adhoc-import-scan` lint rule forbids hand-rolled import regexes so the class
cannot reappear.

The **sibling MARKER-ID class is still open.** Several build-time scanners call
`maskSource(src, { strings: false })` (comments/regex blanked, **string
interiors kept**) and then locate a `defineX(...)` call and read its first string
argument — an id, slot id, or route URL. Because string interiors are kept, a
`defineX("id")` written *inside* a string or template literal is still visible in
the masked text, so the call-locating regex (`markerCallSpans`, a bespoke
`callRe`, or `extractContributionsBlock`/`findCalls`) matches it and its id is
extracted as a real contribution.

The root cause is a subtly-wrong contract documented in
`parse-utils/CLAUDE.md`: it currently says `{ strings: false }` is *reserved for*
a marker/value scanner "which locates the enclosing call via `markerCallSpans` /
`findMarkerCalls` / `matchBracket`." That is exactly the trap — `markerCallSpans`
matches the call against the text it is *given*, so feeding it a strings-kept
mask makes a string-embedded call match. The correct, already-proven contract is
**mask fully, locate the call over the full mask, and read the value back from
the *original* source by offset** — precisely what `findMarkerCalls(src, marker)`
does (it masks with `{ strings: true }` and slices `argsText` from the original).

`db-schema/facet` is the reference-correct shape: it masks with `{ strings: true }`
so a stringified `pgTable(` can never misclassify a file.

### Two sub-classes (they get different fixes)

1. **Marker-value scans** — the value is the argument of a real `defineX(...)`
   code call. *Fix:* mask fully + `markerCallSpans`/`findMarkerCalls` + read the
   value from the original by offset. A string-embedded call then vanishes from
   the masked text; a real call's blanked id is recovered from the original.
2. **Bare token-in-string scans** — the token *legitimately* lives inside a
   string literal in real code and has **no enclosing marker call** (e.g. an
   `/api/<prefix>` URL a caller passes to `fetch(...)`, a MIME string). Masking
   fully would erase the very thing being searched for. `{ strings: false }` is
   *correct* here; the residual fixture/docs false-positive is inherent and is
   mitigated by excluding test files. These are the sanctioned exceptions and go
   on the lint allowlist.

## Goal

- Route every **marker-value** scanner through the full-mask + read-by-offset
  contract; eliminate their `{ strings: false }`.
- Add a `no-adhoc-marker-scan` lint rule that forbids `maskSource(…, { strings:
  false })` everywhere except a small, reviewed allowlist of genuine
  token-in-string scanners — so the class cannot reappear (mirrors
  `no-adhoc-import-scan`).
- Correct the primitive documentation so the trap is not re-sanctioned.

## Primitives to reuse (do not reinvent)

- `findMarkerCalls(src, marker)` — masks `{ strings: true }`, returns
  `{ index, argsText }` with `argsText` sliced from the **original**. The default
  path for "find every `defineX(...)` and read its args."
  (`plugins/plugin-meta/plugins/parse-utils/core/find-marker-calls.ts`)
- `markerCallSpans(masked, marker)` — byte spans of every `defineX[<…>](…)` in
  **already-masked** source. Use when you also need surrounding context (e.g. the
  member/group name preceding the call): pass a **full** `maskSource(src)` and
  read values from the original at the returned offsets.
- `matchBracket`, `parseStringField`, `parseBoolField`, `lineAt` — from
  `@plugins/plugin-meta/plugins/parse-utils/core`.
- Lint-plugin shape: `plugins/framework/plugins/tooling/plugins/lint/plugins/import-scan-safety/`
  (`lint/index.ts` exports `{ name, rules, ignores }`; the root `eslint.config.ts`
  applies each rule repo-wide and honours the per-rule `ignores` allowlist).

## Changes

### A. Marker-value scanners → full-mask + read-by-offset

1. **`plugins/framework/plugins/tooling/plugins/codegen/core/data-views-gen.ts`**
   (~L93–98). Currently `findMarkerCalls(maskSource(src, { strings: false }),
   "defineDataView")` — a double-mask that also defeats `findMarkerCalls`'s own
   internal masking. Replace with `findMarkerCalls(src, "defineDataView")`.
   `firstStringArg(call.argsText)` keeps working (argsText is now sliced from the
   original). One-line fix; drop the now-unused `maskSource` import if orphaned.

2. **`plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-scan.ts`**
   (~L43–46, L84–111, L236, L264, L274). Remove the bespoke
   `findCallsWithOptionalGeneric` + `maskSource(raw, { strings: false })` and
   drive the scan from `findMarkerCalls(raw, marker)` (or
   `markerCallSpans(maskSource(raw), marker)` if the surrounding member context is
   needed). Read ids from the returned `argsText` via the existing
   `leadingStringLiteral`. Verify the `reorderable-slots-in-sync` check still
   passes (output must be byte-identical for real calls).

3. **`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`**
   (`parseSlotCalls` L27–62; call sites L171–186). Locate calls with
   `markerCallSpans(maskSource(stripTypes(src)), builder)` (full mask), read the
   id from the **original** `stripTypes(src)` at each span's `open+1`, and compute
   the member/group name from the **full-masked** prefix (so a `Word:` inside a
   string can't invent a false member). Pass raw + masked instead of the current
   `{ strings: false }` buffer.

4. **`plugins/plugin-meta/plugins/parse-utils/core/helpers.ts`** — `parseDefineGroup`
   (shared; only caller is `slots/facet`). Today it reads `"([^"]+)"` from the
   buffer it is handed, so a full mask would blank the id. Rewrite it to take the
   raw/stripped source, mask fully internally for the `export const Group = {` +
   member detection, and read each id from the **original** by offset (reuse
   `markerCallSpans` for the `Member: defineSlot(...)` calls). Update its single
   call site in `slots/facet` to pass the raw source.

5. **`plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/check/index.ts`**
   (L94–102). Feed `markerCallSpans` a **full** `maskSource(src)`; slice each
   call `block` from the **original** so `parseStringField(block, "mode")` reads
   the real `"keyed"`. The existing `isTestPath` guard can stay but becomes
   belt-and-suspenders (full masking already excludes string-embedded calls).

6. **`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts`**
   (L36–60) and its `./internal/static-parse.ts`
   (`extractContributionsBlock`, `findCalls`, `parsePropsBlock`). Locate the
   contributions block and each call over a **full** `maskSource(stripped)`, and
   slice `argsBody`/prop strings from the **original** at the matched offsets so
   real slot names + prop values are recovered. `parseImports` already routes
   through `findImports` and is unaffected.

### B. Genuine token-in-string scanners → allowlist (keep `{ strings: false }`)

7. **`plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts`**
   (`relate()` caller scan, L125–140). This searches for an `/api/<prefix>` URL
   that legitimately lives inside caller string literals with **no enclosing
   marker call** — masking fully would erase it, so `markerCallSpans` does not
   apply. Keep `{ strings: false }`, tighten the comment to state it is a
   sanctioned token-in-string scan, and **skip test/fixture files** (`*.test.ts(x)`,
   `__tests__/`) to remove the fixture leg of the false positive. Allowlist it.

8. **`plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/parse.ts`**
   (L44–45). This is a careful **dual-mask**: statement-boundary detection runs on
   the *full* mask (so string braces can't mis-split), and only the final
   statement *text* is sliced from the strings-kept copy at identical offsets.
   Structurally sound; keep as-is and allowlist. (A future cleanup could route its
   `extractFromSpecifier` through `findImports`; out of scope here — file a
   follow-up.)

### C. Lint rule — prevent reappearance

9. New lint plugin **`plugins/framework/plugins/tooling/plugins/lint/plugins/marker-scan-safety/`**
   mirroring `import-scan-safety`:
   - `lint/no-adhoc-marker-scan.ts` — an ESLint rule firing on a `CallExpression`
     whose callee is `maskSource` and which has an object argument with a
     `strings: false` (`Literal` `false`) property. Message: keeping string
     interiors means a `defineX("id")` / value written inside a string literal is
     matched as real; route marker-value scans through `findMarkerCalls` /
     `markerCallSpans(maskSource(src), …)` (full mask + read by offset); only a
     genuine token-in-string scan with no enclosing call may keep strings, and it
     must be allowlisted here (prefer `grepCode`).
   - `lint/index.ts` — `export default { name: "marker-scan-safety", rules: {
     "no-adhoc-marker-scan": … }, ignores: { "no-adhoc-marker-scan": [ <routes
     facet>, <plugin-boundaries parse.ts>, <mask-source.test.ts>,
     <find-marker-calls.test.ts> ] } }`.
   - `CLAUDE.md` — explain the class and the sanctioned exceptions (mirror
     `import-scan-safety/CLAUDE.md`).

### D. Documentation

10. **`plugins/plugin-meta/plugins/parse-utils/CLAUDE.md`** — rewrite the
    `{ strings: false }` bullet: it is **not** safe for marker-value scans (even
    with `markerCallSpans`); those must full-mask + read-by-offset via
    `findMarkerCalls`. `{ strings: false }` is reserved for a genuine
    token-in-string scan (URL/MIME/path) with no enclosing marker call, enforced
    by `no-adhoc-marker-scan`.
11. **`find-marker-calls.ts`** doc comment on `markerCallSpans` — add a one-line
    caution that a **full** mask is required to be string-embedding-safe.
12. New plugin `CLAUDE.md` + the auto-generated docs kept in sync by
    `./equin build` (`plugins-doc-in-sync`, `plugins-have-claudemd`).

## Verification

- `./equin build` — regenerates `data-views` and `reorderable-slots`
  scans, runs all checks. The `data-views-in-sync`, `reorderable-slots-in-sync`,
  `plugins-registry-in-sync`, `plugins-doc-in-sync`, and `type-check` checks must
  pass (real-call output must be byte-identical — only string-embedded phantoms
  change, of which there are currently none).
- `./equin check` — full pass, including the new `eslint`-hosted
  `no-adhoc-marker-scan` rule (green on the refactored files, and its `ignores`
  allowlist covers the two sanctioned scanners + two tests).
- Targeted unit tests (run after build so `node_modules` is present):
  - Extend `find-marker-calls.test.ts` (or add a focused test) proving a
    `defineDataView("x")` / `defineRenderSlot("y")` written inside a string
    literal is **not** returned, while a real adjacent call still is.
  - `bun test plugins/plugin-meta/plugins/parse-utils` — `parseDefineGroup` /
    `markerCallSpans` regression.
- Sanity: add a throwaway fixture (a `.ts` string containing
  `defineDataView("phantom")`) in a scratch file, confirm it does **not** appear
  in generated output, then remove it.

## Out of scope / follow-ups to file

- Routing `plugin-boundaries/parse.ts` `extractFromSpecifier` through
  `findImports` (kept as an allowlisted dual-mask for now).
- `db-schema` `parseTableNames`/`parseEntityExtensionCalls` run on
  `stripTypes(raw)` with **no** comment/regex masking — a commented-out
  `pgTable("x")` would register. Separate narrow gap; file a follow-up.
