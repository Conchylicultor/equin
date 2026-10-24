# Source-scanning tooling must ignore comments and string literals

**Date:** 2026-06-08
**Category:** global (codegen · checks · boundaries · facets · lint)
**Status:** Plan — awaiting approval

## Context

Build-time tooling that detects markers by string/regex-matching raw source text
treats matches inside **comments** and **string literals** as real code. The
trigger: `discoverCollectedDirs` (codegen) matched a `defineCollectedDir("…")`
call written in a **code comment** and silently generated a phantom
`<dir>.generated.ts` runtime registry, which then broke the `typescript` check.
No warning — wrong output from text that was never code.

This is a **whole class**, not one scanner. The repo has **no AST-based source
analysis anywhere**; every codegen generator, several `./equin check`
rules, and the boundary checker hand-roll regex/`includes`/`git grep` over raw
bytes. Three of them already re-implement comment/string skipping independently
(`matchBracket`, boundaries' private `stripComments`, plus every ad-hoc regex),
so the same bug recurs everywhere with no shared defense.

**Outcome:** one shared *source-masking* primitive that blanks comments (and,
where appropriate, string interiors) while preserving offsets, with every
raw-text scanner routed through it — so a marker in a comment or string can never
again produce phantom codegen output or a false check violation.

## Root cause / the class

A scanner is vulnerable when it matches a pattern against unparsed source and the
pattern can appear in a comment or string. Two execution contexts:

1. **Bun build-time scanners** (codegen + facets + boundaries) — `readFileSync` +
   regex / `matchBracket`. Fixable with an in-process masking pre-pass.
2. **`git grep` checks** (the `no-raw-*` family) — shell out to `git grep` over
   raw bytes for speed. Can't use an AST cheaply; need a masking *post-filter*.

A single text-masking primitive serves both. (An AST would unify only context 1
while forcing a rewrite of the entire `matchBracket`/`parseDefineGroup`/
`parseBarrelExports` family and still leaving context 2 on text — strictly
worse. See *Rejected alternative*.)

## Design

### 1. Core primitive — `maskSource` (parse-utils)

New file `plugins/plugin-meta/plugins/parse-utils/core/mask-source.ts`, exported
from `parse-utils/core/index.ts`:

```ts
export function maskSource(src: string, opts?: { strings?: boolean }): string
```

Returns a string of **identical length** (offsets + newlines preserved) where:
- line comments (`// …`) and block comments (`/* … */`) → spaces;
- **regex literals** (`/…/flags`) → spaces (opaque) — required because the
  scanner files themselves contain marker-shaped regexes (e.g. codegen's
  `DEFINE_RE = /defineCollectedDir\(…/`); uses the standard "regex vs divide"
  heuristic (a `/` is a regex start unless the previous non-space token is an
  identifier / number / `)` / `]`);
- string/template-literal **interiors** → spaces **iff `opts.strings` (default
  `true`)**; delimiters (`"`/`'`/`` ` ``) are always kept so structural regexes
  like `from "…"` still see the quotes.

Because length/offsets are preserved, a regex match index in the masked text maps
1:1 back to the original — callers read real string values from the **original**
at the matched offset. This generalizes and replaces both the private
`stripComments` in `boundaries/core/check.ts:67` and the inline skip-loop in
`matchBracket` (which `maskSource` can be layered with or reuse).

**Two usage modes (the teachable rule):**
- `strings: false` (mask comments + regex, keep string interiors) → for
  extractors whose captured value *lives in a string*: import paths, route
  strings, model ids, hardcoded paths/colors.
- `strings: true` (also mask string interiors) → for detectors of *code
  constructs* that must never match inside a string: `new WebSocket(`, `… as T`
  casts, and `defineX(` marker calls.

### 2. Convenience — `findMarkerCalls` (parse-utils)

```ts
export interface MarkerCall { index: number; argsText: string }
export function findMarkerCalls(src: string, marker: string): MarkerCall[]
```

Masks with `{ strings: true }`, finds genuine `\bmarker\s*\(` occurrences, uses
`matchBracket` on the **original** `src` to capture the balanced `(...)`, and
returns `argsText` sliced from the **original** (delimiters intact) for the
caller to parse with the existing `parseStringField` / `parseBoolField`. This one
helper replaces the bespoke detect-regex in every `defineX(` scanner.

### 3. Check glue — `grepCode` (checks/core)

New `plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts`,
exported from `checks/core/index.ts`:

```ts
export interface CodeMatch { path: string; line: number; text: string }
export async function grepCode(opts: {
  root: string;
  pattern: RegExp;            // source of truth; run in JS on masked text
  grepArg: string; fixed?: boolean;   // narrows candidate files via git grep
  maskStrings?: boolean;      // default true
  pathspecs?: string[];       // default ["*.ts", "*.tsx"]
}): Promise<CodeMatch[]>
```

`git grep -l` (fixed `-F` or `-E`) narrows candidate files fast → each candidate
is read, `maskSource`-ed, and re-scanned with `pattern` to yield **real-code**
matches with accurate line numbers + original line text. Each check keeps its own
`ALLOWED_PATHS` / `research/` filtering on the returned paths. Removes the crude,
incomplete `content.startsWith("//")` post-filters (which miss block comments and
string literals entirely).

## Migration (full class sweep)

### Codegen — `codegen/core/plugin-registry-gen.ts`
- `discoverCollectedDirs` (L54/79–83): replace `DEFINE_RE` loop with
  `findMarkerCalls(src, "defineCollectedDir")` → `parseStringField(argsText,…)`
  (or first string arg). **Fixes the trigger bug.**
- `hasDefaultExport` (L118–124): test regexes against `maskSource(src,{strings:false})`.
- `collectImportPrefixes` (L164–185): run `IMPORT_FROM_RE` against
  `maskSource(src,{strings:false})` (keep the path string, blank comments).

### Facets (plugin-meta/plugins/facets/plugins/…)
- `resources/facet/parse-resources.ts`: `defineResource(` → `findMarkerCalls`.
- `db-schema/facet/index.ts`: `findDbFiles` `pgTable(`/`pgView(` content sniff →
  test on masked text; `parseEntityExtensionCalls` `defineExtension` → `findMarkerCalls`.
- `routes/facet/index.ts`: `relate()` `/api/…` URL scan → `maskSource(src,{strings:false})`
  before the regex (keep the URL string, drop commented/doc occurrences).
- (`commands`/`slots`/`contributions`/`exports`/`cross-refs` already use
  `stripTypes`/`matchBracket`; switch their detection regexes onto `maskSource`
  too for uniformity where they currently scan raw text — `cross-refs` notably
  has no comment masking today.)

### Boundaries — `boundaries/core/check.ts`
- Delete the private `stripComments` (L67–117); import `maskSource(src,{strings:false})`
  from parse-utils. (framework/tooling → plugin-meta is already an allowed edge —
  codegen imports `plugin-tree/core`.) Removes a duplicate implementation.

### `git grep` checks → `grepCode` (with per-check `maskStrings`)

| Check | Target | `maskStrings` |
|---|---|---|
| `no-raw-websocket` | `new WebSocket(` (construct) | **true** |
| `no-raw-event-source` | `new EventSource(` (construct) | **true** |
| `no-use-resource-cast` | `… as T` cast (construct) | **true** |
| `no-raw-sse` | `text/event-stream` (banned string) | false |
| `no-hardcoded-colors` | Tailwind classes in className strings | false |
| `no-plugin-imports-in-core` | import path strings | false |
| `no-relative-server-imports` | import path strings | false |
| `model-provider:no-raw-model-flags` | `claude-*-N` ids in strings | false |
| `endpoints:typed-handlers` | `"VERB /api/…":` route keys | false |
| `endpoints:typed-web-fetches` | `fetch("/api/…")` count | false |
| `paths:no-hardcoded-paths` | path strings + `homedir()` call | false |

`no-reexport-default` (readFileSync, not git grep): run its three regexes against
`maskSource(src,{strings:false})`.

### ESLint — `no-arbitrary-font-size` (separate mechanism, same family)
`plugins/ui/plugins/tokens/plugins/typography/lint/no-arbitrary-font-size.ts`:
already AST-based but visits **every** `Literal`/`TemplateElement`, so a doc/comment
string mentioning `text-[10px]` errors. Scope it to className context using the
same `collectTokens`-on-`className`-`JSXAttribute` approach the sibling
`no-adhoc-*` rules use. (No `maskSource` here — it's an over-scoping fix.)

## Guardrail — tests + docs

- **Unit tests** for `maskSource` (comments, block comments, nested strings,
  template literals, regex literals, offset/length invariance) and
  `findMarkerCalls`.
- **Regression tests**: a fixture source containing `// defineCollectedDir("phantom")`
  and `const s = "defineCollectedDir('x')"` produces **no** discovered dir / facet
  entry; a fixture with `// new WebSocket(` produces no `no-raw-websocket` offender.
- **Docs**: in `parse-utils/CLAUDE.md` (and a one-liner in `checks` CLAUDE.md),
  state that all build-time source scanning MUST route through
  `maskSource` / `findMarkerCalls` / `grepCode` — never raw `readFileSync`+regex
  or bare `git grep`. Consolidating onto one primitive *is* the structural fix;
  future scanners inherit the defense by reuse.

## Files to modify

Primitives (new):
- `plugins/plugin-meta/plugins/parse-utils/core/mask-source.ts` (+ barrel export)
- `plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts` (+ barrel export)

Codegen / facets / boundaries:
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`
- `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts`
- `plugins/plugin-meta/plugins/facets/plugins/db-schema/facet/index.ts`
- `plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts`
- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/facet/index.ts`
- `plugins/framework/plugins/tooling/plugins/boundaries/core/check.ts`

Checks (route through `grepCode` / `maskSource`):
- `…/checks/plugins/no-raw-websocket/check/index.ts`
- `…/checks/plugins/no-raw-event-source/check/index.ts`
- `…/checks/plugins/no-raw-sse/check/index.ts`
- `…/checks/plugins/no-hardcoded-colors/check/index.ts`
- `…/checks/plugins/no-plugin-imports-in-core/check/index.ts`
- `…/checks/plugins/no-relative-server-imports/check/index.ts`
- `…/checks/plugins/no-use-resource-cast/check/index.ts`
- `…/checks/plugins/no-reexport-default/check/index.ts`
- `plugins/conversations/plugins/model-provider/check/index.ts`
- `plugins/infra/plugins/endpoints/check/index.ts`
- `plugins/infra/plugins/endpoints/check/typed-web-fetches.ts`
- `plugins/infra/plugins/paths/check/index.ts`

ESLint:
- `plugins/ui/plugins/tokens/plugins/typography/lint/no-arbitrary-font-size.ts`

Reuse (unchanged, depended upon): `parse-utils/core/helpers.ts`
(`matchBracket`, `parseStringField`, `parseBoolField`, `stripTypes`, `readIfExists`).

## Verification

1. `./equin build` — regenerates all `*.generated.ts`. The
   `plugins-registry-in-sync`, `facets:render-complete`, and `plugins-doc-in-sync`
   checks must stay green (proves no phantom/dropped entries from the rewrite).
2. `./equin check` — full suite green; specifically `typescript`,
   `plugin-boundaries`, `eslint`, and every migrated `no-raw-*` check.
3. Run the new unit + regression tests (`bun test` in the affected plugins).
4. **Negative proof of the trigger**: temporarily add `// defineCollectedDir("phantom")`
   to a `core/*.ts` file, run `./equin build`, confirm **no**
   `phantom.generated.ts` appears and `typescript` stays green; remove it.
5. **No false-negative regression**: confirm a real `new WebSocket(` / real
   hardcoded color / real `defineResource({…})` is still detected after the
   migration (the masking must not hide genuine code).

## Rejected alternative — TS compiler AST

`typescript@~5.8.3` is already in `node_modules`. Rejected because: (a) it cannot
cheaply serve the `git grep` checks (parsing every candidate file with the
compiler is far heavier than masking), so the class would stay split across two
paradigms; (b) it forces rewriting the entire regex-based facets parser family
(`matchBracket`/`parseDefineGroup`/`parseBarrelExports`) or living with a
permanent AST-vs-regex split — both less clean than consolidating three existing
skip-loops into one masking primitive; (c) compiler cold-start cost on every
build. Masking is the cleaner long-term fit *for this codebase*: one primitive,
both contexts, fewer paradigms.
