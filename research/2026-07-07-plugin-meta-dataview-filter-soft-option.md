# DataView Filter/ValueCodec/ColumnConfig contributors → composition-selectable

## Context

In a filtered **composition release**, a `<DataView>`'s Filter pill and typed
value-codecs degrade to fail-soft: the `fields.*.filter`,
`fields.*.data-view-codec`, and `fields.enum.column-config` contributors cannot
be added to the `data-views` composition pack. The `composition-closure` check
rejects selecting `fields.*.filter` with *"…is not a genuine soft option"*, so
the pack
(`plugins/plugin-meta/plugins/composition/core/config.ts`) can only carry the
four view types + the per-field-type cell/inline-editor renderers. A released
DataView therefore has working view tabs and cell rendering but silently loses
filtering.

### Root cause (empirically verified against the real engine)

The asymmetry is **not** in the closure classifier and **not** in the six
`defineSlot` definitions — `classifyEdges` treats every `DataViewSlots.*` member
identically (it only reads the group head `"DataViewSlots"`, never the individual
slot). The bug is a **blind spot in the static contribution parser**:

`plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts`
→ `findCalls()` (line 77-89) uses:

```ts
const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(\s*\{/g;
```

The trailing `\{` requires the contribution call's argument to be an **inline
object literal**. All six Filter contributors instead pass a *pre-built named
constant*:

```ts
// plugins/fields/plugins/{bool,date,enum,number,tags,text}/plugins/filter/web/index.ts
contributions: [DataViewSlots.Filter(textOperatorSet)],   // ← bare identifier, not `{…}`
```

So the regex never matches → no `"DataViewSlots.Filter"` entry lands in
`contributions.static` → `classifyEdges` (which reads **only** `data.static`,
`classify-edges.ts:89`) never creates a soft edge `fields.*.filter →
primitives.data-view` → the id never appears in `resolveComposition`'s
`available` frontier → `composition-closure`'s genuine-soft-option gate
(`check/index.ts:158-169`, `without.available.includes(id)`) fails.

**Scope nuance:** only `Filter` is genuinely broken. Every `ValueCodec`
(bool/date/number) and `ColumnConfig` (enum) call site uses an inline object
literal (`DataViewSlots.ValueCodec({ match: "number", codec: numberCodec })`),
so they are **already** captured and are already genuine soft options today — a
live `resolveComposition` run confirms `fields.number.data-view-codec` /
`fields.enum.column-config` are selectable while `fields.text.filter` is not.
The pack's current `NOTE` comment lumping all three together as non-selectable is
stale/over-broad.

This is the same class of fragility the recent
*"route remaining import scanners through findImports; forbid ad-hoc import
regexes"* work targeted: a regex text-scraper that silently drops contributions
whose props aren't inline literals is a footgun for **every** current and future
plugin that factors its contribution argument into a variable — not just these
six. The fix is structural (fix the parser), not per-call-site.

## The fix

### 1. Make the static contribution parser argument-shape-agnostic

**File:** `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts`
→ rewrite `findCalls(block)`.

Requirements:
- Capture every **top-level** contribution call in the `contributions: [ … ]`
  block — i.e. each array element of shape `Group.Member(<anything>)` — recording
  its `callee` regardless of whether the argument is an inline `{…}`, a bare
  identifier (`textOperatorSet`), a helper call, or a spread.
- **Preserve today's prop parsing** for the inline-literal case: when the first
  non-whitespace char after `(` is `{`, set `argsBody` to that object's body
  (so `parsePropsBlock` still yields `props` for `Pane.Register`, `match`, etc.).
  Otherwise `argsBody = ""` (→ `parsePropsBlock("") = {}`), which is correct —
  the slot identity comes from the *callee*, not the argument.
- **Never match nested calls inside an argument** (e.g.
  `DataViewSlots.Cell({ component: wrap(Foo.bar(x)) })` must not emit a phantom
  `Foo.bar` slot). Achieve this by jumping the scan cursor past each matched
  call's balanced `)` via `matchBracket`.
- **String-safe.** The `block` handed to `findCalls` is comments-masked but
  strings-preserved (`extract` builds it via `maskSource(stripped, { strings:
  false })`), so a string like `"a.b(c"` in a prop value must not false-match.
  Scan a fully-masked copy and slice `argsBody` from the original (offsets align
  1:1 because `maskSource` preserves length — same `src`+`masked` idiom already
  used by `codegen/core/reorderable-slots-scan.ts`).

Reference implementation:

```ts
import { matchBracket, maskSource, /* …existing… */ } from
  "@plugins/plugin-meta/plugins/parse-utils/core";

export function findCalls(block: string): { callee: string; argsBody: string }[] {
  const masked = maskSource(block); // default masks strings too; length preserved
  const out: { callee: string; argsBody: string }[] = [];
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g; // no `{` requirement
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const callee = m[1]!;
    const openIdx = m.index + m[0].length - 1;          // index of "("
    const closeParen = matchBracket(masked, openIdx, "(", ")");
    if (closeParen < 0) continue;
    // Inline object-literal argument → keep its body for parsePropsBlock.
    let argsBody = "";
    let j = openIdx + 1;
    while (j < masked.length && /\s/.test(masked[j]!)) j++;
    if (masked[j] === "{") {
      const closeBrace = matchBracket(masked, j, "{", "}");
      if (closeBrace >= 0) argsBody = block.slice(j + 1, closeBrace); // strings intact
    }
    out.push({ callee, argsBody });
    re.lastIndex = closeParen + 1; // resume AFTER this call → skip nested dotted calls in args
  }
  return out;
}
```

**Blast radius:** `findCalls` (and `extractContributionsBlock`) has exactly one
consumer — `contributions/facet/index.ts`. The similarly-named
`findCallsWithOptionalGeneric` in `codegen/core/reorderable-slots-scan.ts` is a
*separate* function and is untouched. The change is strictly additive to
`data.static` (it can only *add* newly-visible contributions), so it cannot make
any existing `composition-closure` selection fail, and docgen output is
unchanged (docgen's `SlotDef.contributors` already sees Filter via the
barrel-import `data.runtime` path).

### 2. Carry the contributors in the `data-views` pack

**File:** `plugins/plugin-meta/plugins/composition/core/config.ts`
(`pack("data-views", …)`, lines ~225-244).

- Add the 10 now-selectable contributors:
  - Filter (6): `fields.bool.filter`, `fields.date.filter`, `fields.enum.filter`,
    `fields.number.filter`, `fields.tags.filter`, `fields.text.filter`
  - ValueCodec (3): `fields.bool.data-view-codec`, `fields.date.data-view-codec`,
    `fields.number.data-view-codec`
  - ColumnConfig (1): `fields.enum.column-config`
- Replace the stale `NOTE:` comment (lines 216-224) with a short note that these
  are the Filter-pill / typed-codec / enum-column-config contributors, now
  selectable after the static-parser fix.

### 3. Regression test for the parser

**New file:** `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.test.ts`
(`bun:test`, co-located — pure logic). Assert `findCalls`:
- captures a bare-identifier-arg call: `DataViewSlots.Filter(textOperatorSet)` →
  `callee: "DataViewSlots.Filter"`, `argsBody: ""`.
- still captures + parses an inline-literal call:
  `DataViewSlots.Cell({ match: "bool", component: BoolCell })` → props include
  `match`.
- does **not** emit a phantom slot for a dotted call nested inside an argument.
- handles a dotted call inside a preserved string without false-matching.

Run: `bun test plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.test.ts`

## Verification

1. `./equin build` — regenerates facets/docs; must succeed. Confirms the
   parser change doesn't perturb `plugins-doc-in-sync` / `plugins-registry-in-sync`.
2. `./equin check composition-closure` — must pass with the 10 new
   contributors in the `data-views` pack (this is the check that previously
   rejected them).
3. `bun test plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.test.ts`
   — the new unit test.
4. `bun test plugins/plugin-meta/plugins/closure/core/closure.test.ts` and
   `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts` — the
   existing engine/pack tests still pass.
5. Spot-check in the running app (`http://<worktree>.localhost:9000` → Studio →
   Compositions): a composition that `extends: ["data-views"]` (e.g. `sonata`)
   now shows the Filter/codec contributors as `contributor` (selected) rather
   than `available`/`excluded`.

## Critical files

- `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.ts` — `findCalls` rewrite (the fix)
- `plugins/plugin-meta/plugins/composition/core/config.ts` — `data-views` pack + comment
- `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/internal/static-parse.test.ts` — new regression test
- (read-only references) `plugins/plugin-meta/plugins/closure/core/classify-edges.ts`, `.../closure/core/resolve-composition.ts`, `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/index.ts`
