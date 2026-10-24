# Plugin descriptions: stop re-parsing transpiler output, fail loudly on a non-literal

## Context

A plugin whose `description` string contains a double-quote character silently loses its
description in **every** generated artifact — `docs/plugins-compact.md`,
`docs/plugins-details.md`, and the plugin's own `CLAUDE.md` autogen block. The plugin
appears in its umbrella's sub-plugin list as a bare name with no text. Nothing errors, and
`plugins-doc-in-sync` passes green: the check re-renders from the same buggy generator and
compares byte-for-byte, so the committed doc *does* match what the generator produces. The
drift check structurally cannot see the loss.

### Mechanism

`plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts:199-206` recovers the
description with `parseStringField(stripTypes(src), "description")`. `stripTypes` is a Bun
transpile, and the transpiler **re-quotes** string literals. Measured behavior:

| Source literal | Transpiler re-emits as | `parseStringField` result |
| --- | --- | --- |
| `"a onDelete:\"cascade\" bound"` | `'a onDelete:"cascade" bound'` (single-quoted) | `undefined` — **description lost** |
| `"it's a \"q\" thing"` | `` `it's a "q" thing` `` (backtick) | matches, but backtick branch runs `.replace(/\s+/g," ")` — **whitespace silently collapsed** |
| `"line\nbreak"` | `` `line⏎break` `` (backtick, real newline) | matches, **newline silently collapsed to a space** |

So it is not one bug: the emitter has three behaviors and the parser mishandles two of them
in two different ways. `parseStringField`
(`plugins/plugin-meta/plugins/parse-utils/core/helpers.ts:81-87`) matches only
double-quoted and backtick literals, never single-quoted, and returns `undefined` when it
fails. The caller's `if (serverDesc)` guard absorbs that as "this plugin has no description".

This is an **absorbed failure at a parser boundary**: an `undefined` meaning "parse failed"
is indistinguishable from "field absent" — exactly the class the repo's `no-absorbed-failure`
rule exists to prevent (`research/2026-07-08-global-absorbable-failure-guardrail.md`) — and
the docs pipeline bakes the loss into a committed artifact that its own in-sync check then
blesses.

### Two adjacent fragilities in the same function

Established while tracing, both latent today:

1. **No escape-cooking.** The double-quote branch returns the raw regex capture, backslashes
   intact. A `\n` or `\\` in a description would render literally as `\n` in the docs. The
   transpiler's backtick rewrite currently masks this.
2. **Whole-file, first-match scan.** `parseStringField` has no comment/string awareness of its
   own and scans the entire file, so it takes the *first* `description:` anywhere — not the
   barrel's own. Barrel purity keeps this from firing today, but nested contribution objects
   routinely carry their own `description:` (e.g. `plugins/active-data/web/index.ts` has two).

### Correctness constraint

Grepping all 994 barrels: **no plugin currently trips any of these paths** (no escaped quotes,
no backtick descriptions, no escapes, no nested `description:` preceding the top-level one).
Therefore a correct fix must regenerate every doc **byte-identically**. A non-empty
`git diff docs/` after the fix means a regression, not an improvement. This is the primary
verification signal.

### Non-obvious fact that shapes the fix

Root `CLAUDE.md` and `parse-utils/CLAUDE.md` both describe the barrel form as
`export default <definePlugin(...)>`. That is **stale**: zero barrels call `definePlugin`. All
994 use `export default { … } satisfies PluginDefinition` — an object literal, not a call. So
`findMarkerCalls(src, "definePlugin")` is not the anchor; the default-export object literal is.

## Intended outcome

- A description containing any quote character round-trips exactly into the docs.
- A `description:` that cannot be read as a static string literal **throws at build**, with the
  file path and the offending expression. It becomes impossible to commit.
- The parser stops recovering values by re-parsing transpiler output — a fragility that exists
  for every quoting form the emitter may choose today or in a future Bun release.

## Approach

### 1. `parse-utils` — a real string-literal reader, and a discriminated result

`plugins/plugin-meta/plugins/parse-utils/core/helpers.ts`

Add `readStringLiteral(src, at)`: reads the literal beginning at offset `at` in *original*
source. Handles all three quote forms (`"`, `'`, `` ` ``). Cooks escapes properly —
`\n \r \t \b \f \v \0 \\ \' \" \` `, `\xHH`, `\uHHHH`, `\u{…}`, line continuations; any other
escaped char yields the char itself. Rejects a template containing an unescaped `${`.
Backtick literals keep today's whitespace-collapse (`\s+` → single space, trimmed) since that
is a deliberate affordance for prose wrapped across source lines — but the collapse now
applies only to literals the *author* wrote as backticks, never to a double-quoted string the
transpiler happened to rewrite.

Change `parseStringField` to return a discriminated result rather than `string | undefined`:

```ts
export type StringFieldResult =
  | { kind: "value"; value: string }
  | { kind: "absent" }                        // no such key in real code
  | { kind: "dynamic"; expr: string };        // key present, value is not a static literal
```

Implementation: `maskSource(src)` **internally** (so a `description:` inside a comment or a
string can never be matched — the function is now safe on a raw buffer, which it is not
today), locate `\b<field>\s*:\s*` in the masked text, then read the literal from the
**original** at the matched offset. `maskSource` preserves offsets 1:1 and keeps quote
delimiters verbatim, so the masked text tells us whether a literal starts there and the
original supplies its bytes. Non-quote value start → `{kind:"dynamic"}` with the expression
snippet.

Add an option to restrict the scan to an object body's **top-level keys only**
(`{ depth0: true }`), skipping nested `{}`/`[]`/`()` blocks. This is what retires the
first-match-anywhere scan.

Add `defaultExportObjectBody(src): string | null` — masks, finds `export default`, takes the
next `{`, and `matchBracket`es to its close. Generic and reusable; `matchBracket` already
skips string/comment interiors.

### 2. `plugin-tree` — read the barrel's own object, drop the transpile

New `plugins/plugin-meta/plugins/plugin-tree/core/internal/barrel-meta.ts`:

```ts
parsePluginBarrel(src: string, file: string):
  { description?: string; loadBearing: boolean; collapsed: boolean }
```

Isolates the barrel's `export default { … }` body via `defaultExportObjectBody`, then reads
`description` (via `parseStringField(body, "description", { depth0: true })`) and
`loadBearing` / `collapsed` (via `parseBoolField` on the same body — same top-level scoping,
so a nested contribution's flag can never leak in).

- `{kind:"dynamic"}` → **throw** `` `${file}: \`description\` is not a static string literal (got \`${expr}\`). The docs pipeline reads this field textually — inline a literal string.` ``
- No default-export object → throw. Every barrel has one; the plugin loader requires it. This
  is a new invariant that cannot fire today.
- `{kind:"absent"}` → genuinely no description (many plugins have none). Unchanged.

Then in `collectCoreFields` (`plugin-tree.ts:187-268`), replace the three
`stripTypes(...)` + six `parseStringField`/`parseBoolField` whole-file calls with three
`parsePluginBarrel` calls. **`stripTypes` disappears from this path entirely** — which is the
root-cause fix, and incidentally removes ~994 Bun transpiles from every full tree build.

`stripTypes` stays exported; other consumers (`facets/slots`, `facets/routes`,
`facets/db-schema`, `facets/contributions`) keep using it and are untouched.

### 3. The other four `parseStringField` call sites

The union forces each to state what "present but dynamic" means:

| File | Field | Decision |
| --- | --- | --- |
| `facets/plugins/resources/facet/parse-resources.ts:109,111,121` | `key`, `mode` | `dynamic` → `null` / default. This is already the *intended* behavior ("no statically-resolvable key" → fall through to the descriptor-index path); it becomes explicit instead of accidental. |
| `facets/plugins/contributions/facet/internal/static-parse.ts:229-230` | `id`, `path`, `segment` | `dynamic` → treated as absent, as today. One-line comment recording that a dynamic pane path is out of scope for the static scanner. |
| `checks/plugins/keyed-resource-scope/check/index.ts:107` | `mode` | `dynamic` → **offender**. Today a `mode: SOME_VAR` silently passes a check whose stated threat model includes deliberate bypass. A `mode:` the scanner cannot prove isn't `"keyed"` gets flagged. Flags nothing today. |

`parseBoolField`'s other caller (`codegen/core/eager-tier-gen.ts:266`, on `argsText`) is
untouched — a boolean field's only valid literal forms are the bare `true`/`false` tokens.

### 4. Docs

- `plugins/plugin-meta/plugins/parse-utils/CLAUDE.md` — document `readStringLiteral`, the
  `StringFieldResult` union, and the rule: **never recover a source value by re-parsing
  transpiler output**; mask the original and read back by offset.
- Root `CLAUDE.md` barrel-purity bullet — correct the stale `export default <definePlugin(...)>`
  to the real `export default { … } satisfies PluginDefinition`.

## Why this needs no new check

`plugins-doc-in-sync` cannot detect the loss because it compares the committed doc against the
same buggy generator. Making the generator **throw** is the guardrail: `./equin build`
(which runs docgen → `buildPluginTree`) and `./equin check` both go red before a lossy
doc can be written, let alone committed. Adding a check that re-implements the parse would just
add a second thing to keep in sync.

Runtime safety: `buildPluginTree` is reachable from two live paths
(`plugin-tree/server/internal/structure-tree-cache.ts`, and the disabled
`review/plugin-changes`), both behind a cache + heavy-read-slot gate. A throw there is caught
per-call by the resource-loader try/catch (`reportLoaderError`) and the `implement()` endpoint
wrapper — it degrades one pane, never the process. And it cannot reach runtime anyway: the
build that produced the barrel would have failed first.

## Files

| Path | Change |
| --- | --- |
| `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts` | `readStringLiteral`, `StringFieldResult`, rewritten `parseStringField`, `defaultExportObjectBody` |
| `plugins/plugin-meta/plugins/parse-utils/core/index.ts` | export the new symbols |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/barrel-meta.ts` | **new** — `parsePluginBarrel` |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts` | `collectCoreFields` uses `parsePluginBarrel`; drop `stripTypes` import |
| `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts` | adapt to union |
| `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts` | adapt to union |
| `plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/check/index.ts` | adapt to union; `dynamic` → offender |
| `plugins/plugin-meta/plugins/parse-utils/core/helpers.test.ts` | **new** (`bun:test`) |
| `plugins/plugin-meta/plugins/plugin-tree/core/internal/barrel-meta.test.ts` | **new** (`bun:test`) |
| `plugins/plugin-meta/plugins/parse-utils/CLAUDE.md`, root `CLAUDE.md` | prose |

## Reuse

Everything needed already exists in `parse-utils`, and the "mask, then read the value back
from the original by offset" idiom is the one its own `CLAUDE.md` already mandates:

- `maskSource(src)` (`core/mask-source.ts:60`) — blanks comments/regex/string interiors, keeps
  quote delimiters and every offset 1:1.
- `matchBracket(src, start, open, close)` (`core/helpers.ts:94`) — already skips string and
  comment interiors.
- `markerCallSpans` / `findMarkerCalls` (`core/find-marker-calls.ts`) — *not* usable here; the
  barrel form is an object literal, not a marker call.

## Verification

1. **Output-neutrality (the load-bearing check).** `./equin build`, then `git diff --stat docs/` and `git diff --stat -- '**/CLAUDE.md'`. Both **must be empty**. Any diff is a regression in the new parser, since no plugin currently exercises the broken paths.
2. **`./equin check`** — green, in particular `plugins-doc-in-sync`, `type-check`, `eslint`, `keyed-resource-scope`.
3. **The bug is actually fixed.** Temporarily set a real plugin's description to
   `"... verifies an FK onDelete:\"cascade\" bound ..."`, run `./equin build`, and confirm
   the description — quotes intact — appears in that plugin's `CLAUDE.md` `## Plugin reference`
   block, in `docs/plugins-compact.md`, and in its umbrella's sub-plugin list. Revert.
4. **Loudness.** Temporarily set a description to `MY_CONST` (and separately to an interpolated
   template). `./equin build` must fail with the file path and the offending expression,
   not silently drop the line. Revert.
5. **Unit tests.** `bun test plugins/plugin-meta/plugins/parse-utils` and
   `bun test plugins/plugin-meta/plugins/plugin-tree`. Cases: all three quote forms; escaped
   quote of the same and the other kind; `\n`/`\\`/`\u{…}` cooking; unescaped `${}` → `dynamic`;
   identifier value → `dynamic`; key absent → `absent`; `description:` inside a comment and
   inside a string → `absent`; a nested `description:` in a contribution object does not shadow
   the top-level one; `export default {}` → `absent`.
6. **Byte-for-byte on the real corpus.** Before/after, dump `{path, description, loadBearing, collapsed}` for all 994 barrels from `buildPluginTree` and diff the two JSON files. Empty diff.
