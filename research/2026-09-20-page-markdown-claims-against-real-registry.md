# The round-trip property runs against the real block registry, and its alphabet comes from what types claim

*2026-09-20 — page/editor*

Supersedes §6 and §7 of
[`2026-09-20-page-markdown-line-claim-escape.md`](./2026-09-20-page-markdown-line-claim-escape.md).
Everything else in that doc (the claim authority, the serialize-side escape, the
parse-side decode, the A2/A3 asserts, the refusal message) has shipped.

## Context

`markdown.ts` is a pure orchestrator: it takes a list of block handles and asks
each one to write a line and to claim a line. The real list is assembled by the
plugin system — 28 plugins, each declaring its handle in its own `core/` file and
contributing it to a web slot and a server slot, both pointing at the same object.

`markdown.test.ts` cannot reach that list, because the block plugins import the
editor (that is where `defineBlock` lives) and importing them back would make the
editor depend on its own dependents. So the suite **hand-writes a copy of 26
handles** and runs everything — including the fuzzed round-trip property, the
executable statement that markdown is a lossless projection — against the copy.

Two things are wrong with that, and they are separate.

**The copy is wrong today, about exactly the tags `edit_page` depends on.**

| copy says | the real block says |
| --- | --- |
| type `agent-notes`, tag `<agent-notes>` | type `agent-note`, tag `<agent-inline id="…">` |
| type `private-notes` | type `private-note` |
| tag `<context>`, no row id | tag `<human id="…">`, `identified: true` |
| `<todo>` with no row id | `<todo id="…">`, `identified: true` |
| — | `instructions` — absent from the copy entirely |
| — | `place` — absent from the copy entirely |

`<agent-inline>` is the tag agents write. The property has never round-tripped
it. `private-notes` is a type string no block has. The copy's `context` even
carries a `TODO ` typing prefix that belongs to a different card. Schema drift
rides along: the copy's `callout` knows 2 of 5 colours, its `bookmark` 4 of 8
fields, and its `image` has no `alt`.

**The fuzz alphabet is what actually let the escape bug through.** The word list
is chosen so no generated paragraph can open with `- `, `3. `, `# ` and so on,
with a comment calling that "a genuine lossiness of markdown itself". The premise
was false. Note that the copy's `numbered-list` regex is byte-identical to the
real one — had the generator ever produced `3. x`, the property would have caught
the bug. Fixing the copy would not have found it; fixing the alphabet would.

**And nothing states what a line claim matches.** A type claims lines through
`markdownPrefixes` or through a hand-written `markdown.parseLine`, and the second
form is a closure nobody can enumerate. The serializer's escape rests on one
leading backslash defeating every claim; `claimSafeLines` asserts that per line at
emit time, but only for lines something actually emitted — and the fuzzer was
built never to emit one.

Outcome: the property runs on the real handles, its alphabet is derived from what
those handles say they claim, and a hand-written claimer must say it.

## Design

### 1. Prerequisite: the stub namespace must not contest a real one

`registerBarrelStubs` declares the runtime namespace `barrel-import-stub`
(`plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts:53`). Under
`bun test`, `test/bun-preload.ts` has already declared the checkout's real
namespace, and `declareRuntimeNamespace` throws on a second, different value. So
any test loading real barrels dies before it reaches block logic.

The dummy exists so server modules that read `runtimeNamespace()` at module eval
can evaluate. A process that already has a real answer does not need a
placeholder, and a placeholder must never contest a real declaration:

```ts
// The stub is a FALLBACK, not an answer. A process told who it is — a bun test
// through its preload, an exec child through its spawner — keeps that identity;
// only a process with none gets the placeholder.
if (!hasRuntimeNamespace()) declareRuntimeNamespace(asNamespace(BARREL_STUB_WORKTREE));
```

`hasRuntimeNamespace()` is already exported from
`@plugins/infra/plugins/runtime-identity/core`. The guard the existing comment
defends — two different *real* answers — is untouched.

### 2. One real-handle loader, shared by the checks and the suite

`collectBlockHandles()` already does the honest enumeration: walk the plugin
tree, find every plugin whose contributions facet declares an `Editor.Block`, load
its web barrel through `importBarrel`, read the contribution's `block`. It fails
loudly on an empty set at each of three levels rather than passing vacuously.

Move it out of `plugins/page/plugins/editor/check/index.ts` into
`plugins/page/plugins/editor/check/block-handles.ts`, unchanged, plus a throwing
wrapper for the suite:

```ts
export async function loadBlockHandles(): Promise<BlockHandle<unknown>[]>
```

sorted by plugin id so the set is deterministic. Order does not decide anything:
`page.editor:block-prefixes-unique` keeps two types off one prefix, and
`markdown.precedence` resolves the one real overlap (`to-do` over
`bulleted-list`).

`markdown.test.ts` imports it **relatively** — `../check/block-handles`. Same
plugin, so no cross-plugin edge exists to be a cycle; the boundary checker only
tracks `@plugins/…` specifiers, and R8 exempts a relative import resolving inside
the source's own plugin. The tooling imports it pulls in already live in this
plugin's `check/`, where `runtimeForPath` returns null and the DAG skips them.

The load happens at **module scope, top-level `await`** — not in `beforeAll` —
so no per-test timer covers it (Bun's default is 5 s per test and this repo
overrides it nowhere).

*Contingency, named because it could not be measured under plan mode:* loading 28
web barrels evaluates real `lexical` and `react-icons` (neither is in
`AUTO_STUB_PACKAGES`). Measure it first. If the load exceeds ~10 s, switch
`loadBlockHandles` to import each contributing plugin's `core/index.ts` instead
and select handles by a brand added to `defineBlock` (a symbol plus an
`isBlockHandle` predicate) — same dir discovery, no lexical, and a declared
predicate rather than duck-typing. Do not reach for it unless the measurement
says to.

### 3. The claim authority becomes askable

`claimantOf` / `stealerOf` are private to `markdown.ts`. Export the one question
both the check and the suite need, beside `markdownTagNameOf`:

```ts
/** Which block type would CLAIM this line away from plain prose, or `undefined`
 *  when the line is ordinary prose. The line is taken as the parse walk sees it. */
export function markdownLineClaim(line: string, ctx: MarkdownContext): string | undefined
```

It is `stealerOf` with the handle reduced to its type — deliberately *not*
`claimantOf`, whose answer for an unclaimed line is the default-text handle, so
"is it claimed" asked as "is it defined" is true of every line ever written.
Re-export it from `editor/core/index.ts`.

### 4. A hand-written claimer declares what it claims

```ts
parseLine?: {
  /** Lines this claimer takes. At least one; each must really be claimed by it. */
  claims: readonly string[];
  parse(line: string, ctx: MdParseCtx): T | null;
};
```

A type error, not a check error: a `parseLine` cannot exist without samples.
`parserFor` reads `.parse`. The four claiming handles declare:

- `numbered-list` — `["1. x", "10) x"]`
- `to-do` — `["- [ ] x", "[ ] x", "* [X] x", "+ [x] x"]`
- `divider` — `["---"]`
- `equation` — `["$$x"]`

Prefix claimers declare nothing new: `markdownPrefixes` already *is* the
declaration, and `prefix + "x"` is its sample.

What this does and does not buy, stated so nobody over-reads it: it makes a claim
*declared* and therefore reachable by a check and by the generator. It cannot
prove the declaration is **complete** — a regex claiming more than its samples
say is still possible, because a closure's language cannot be enumerated. The
exhaustive sweep in §6 is what covers the space the samples do not.

### 5. The check: `page.editor:markdown-claims-are-escapable`

Beside `blockPrefixesUnique` in `plugins/page/plugins/editor/check/index.ts`,
over the handles from §2. For every sample — declared `claims` entries and every
`prefix + "x"` synthesised from `markdownPrefixes`:

1. `markdownLineClaim(sample)` is the declaring type. This also pins the
   precedence order (`to-do` over `bulleted-list` on `- [ ] x`) that nothing
   checks today.
2. `markdownLineClaim("\\" + sample)` is `undefined`. This is the escape's
   correctness proof, and the one fact underivable from `markdownPrefixes`.

Data over the real declarations, deterministic, no search — the same rung and
shape as the two checks already sitting there.

### 6. The alphabet comes from the claims

In the fuzz section of `markdown.test.ts`:

- `CLAIM_LINES` = every declared `claims` entry ∪ every `prefix + "x"`, over the
  real handles. Each is asserted claimed through `markdownLineClaim` before use,
  so a stale entry fails loudly instead of quietly testing nothing.
- `pick(r)` gains one branch: with ~25% probability the text opens with an
  **unmarked** run carrying a random `CLAIM_LINES` entry. Unmarked and first, or
  the marker is not at the line's start and the escape never fires (`**3. x**`
  is claimed by nobody). Delete the `[ ] `/`* ` clause of the exclusion comment —
  it is false, those are inline escape spellings and were never claimable. Keep
  the leading-space and soft-break-at-word-edge exclusions, which are genuine
  canonical-form rules.
- **Non-vacuity:** count emitted lines beginning `\` across the seeds and assert
  the count is well above zero. A regression that stops generating claimable text
  must fail, not pass quietly — which is the exact failure this whole change is
  about.
- **Coverage:** assert the generator's type set equals the registry's type set.
  A 29th block type then arrives as a failing test rather than as silence. Two
  new generators are needed today: `instructions` (`{}` / `{global: true}`) and
  `place` (its explicit numeric `lat`/`lng` and ISO `fetchedAt` attrs).
- **Exhaustive escape sweep:** over the alphabet of characters appearing in any
  `CLAIM_LINES` entry plus space, a digit and a letter, enumerate every string of
  length ≤ 4 and assert `markdownLineClaim("\\" + s) === undefined`. ~50k cheap
  probes. This is the statement the samples cannot make: one backslash defeats
  every claimer over a computed set, not just over what someone remembered to
  declare.

### 7. Delete the copy

`handles` / `mdCtx` / `pasteCtx` become the real set, and the ~340-line mirror
(`markdown.test.ts:33-374`) goes. Per-type describes look their handle up by type
instead of by mirror variable. Their expected output changes to the real
spellings — `<agent-inline id="…">`, `<human id="…">`, `<private-note>`,
`<todo id="…">` — which is the bug being fixed, not collateral.

Five describes build handles whose whole purpose is to be impossible, and those
stay synthetic, layered over the real set exactly as they are layered over the
copy today: `broken` and `tagish` (`line claims`), `clashing` (`identified
tags`), the four collision fixtures (`annotated tags`), `both`
(`typingPrefixes`), and the `flagWith` factory (`tag spellings`). A real handle
cannot express a declaration that must throw.

The `page` mirror already wires itself to the real `pageBlockMarkdown` /
`pageBlockAuthor` and simply stops being special.

**Report, do not narrow.** If a real declaration's full value space does not
round-trip — `instructions` with `global: false` emits no attribute and may come
back as `{}`; `place`'s float formatting — that is a finding to surface, not a
generator to quietly restrict. Narrow only with a comment naming the loss, the
way the file already does for a human `<page>`.

### 8. Not in this change

`markdown-apply/core/plan.test.ts` keeps its own 15-type copy, whose `quote`
already disagrees with `markdown.test.ts`'s, and `touched.test.ts` a partial one.
They
cannot share this loader: it lives in `page/editor/check/`, and `check/` is not a
runtime, so a cross-plugin `@plugins/page/plugins/editor/check` import fails the
boundary grammar (R4). Sharing it needs a boundary-legal home of its own. File a
task; do not widen this change.

## Files to change, in order

1. `plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts` — §1. One
   guard, one comment. Nothing else works until this lands.
2. `plugins/page/plugins/editor/check/block-handles.ts` — new; `collectBlockHandles`
   moved verbatim out of `check/index.ts`, plus `loadBlockHandles()`.
3. `plugins/page/plugins/editor/core/markdown.ts` — export `markdownLineClaim`
   (§3); re-export from `core/index.ts`.
4. `plugins/page/plugins/editor/core/markdown.ts` (`BlockMarkdown.parseLine`) and
   `parserFor` — the `{ claims, parse }` pair (§4).
5. The four claiming handles — `numbered-list-block.ts`, `to-do-block.ts`,
   `divider-block.ts`, `math/plugins/equation/core/equation-block.ts`. Plus the
   `parseLine` fixtures in `markdown-apply/core/plan.test.ts`, which must compile
   even though its copy is out of scope.
6. `plugins/page/plugins/editor/check/index.ts` — the new check, registered in the
   default export (§5).
7. `plugins/page/plugins/editor/core/markdown.test.ts` — §6 and §7, the bulk of
   the diff.
8. Docs — `editor/CLAUDE.md`'s *Markdown is a LOSSLESS PROJECTION* section: the
   line-claim bullet gains that a hand-written claimer declares its samples and
   that the property runs on the real registry. `define-block.ts`'s `markdown`
   field comment gains the same.

## Tests

- **The check fails on a bogus declaration.** Add `claims: ["x"]` to any handle
  and `./equin check page.editor:markdown-claims-are-escapable` must fail
  naming it; remove it and the check passes.
- **Non-vacuity of the loader.** The suite asserts the real handle set is
  non-empty and contains a known type, so a loader that silently returns nothing
  fails rather than making every property trivially true.
- **Generator coverage.** The type-set equality assertion fails when a block type
  is added without a generator.
- **The escape actually fires** in the fuzz corpus — the `\`-line count assertion.
- **The exhaustive sweep** passes over the ~50k enumerated strings.
- **The real tags round-trip**: `<agent-inline id="…">`, `<human id="…">`,
  `<todo id="…">`, `<private-note>`, `<instructions global="true">`, `<place …>`
  each appear in an assertion that the copy could not have made.
- Everything already in the file still passes, with expected output updated to
  the real spellings where the copy was wrong.

## Verification

1. Measure the loader first (§2 contingency): time `loadBlockHandles()` once
   before wiring the suite to it.
2. `./equin test plugins/page`, then `./equin build`, then
   `./equin check`.
3. **The fixed-form evidence.** Revert §2's escape in a scratch edit and confirm
   the fuzz property now FAILS — that is the proof the widened alphabet reaches
   the bug the old word list dodged. Restore it.
4. `./equin check page.editor:markdown-claims-are-escapable` on its own,
   and with the bogus `claims` entry above.
5. **The real pages stay editable.** `read_page` on *[Planned] Installable by
   others* (`block-cc11355f`) against this worktree's deploy, then `edit_page`
   appending a tagless `<agent-inline>` card: applies, creates-only,
   `absorbed_writes: 0`.

## Follow-up, deliberately separate

- The `markdown-apply` copies (§8), which need a boundary-legal home for the
  loader.
- `agent-access/e2e/agent-access-verify.ts`'s **E4** still passes only because its
  fixture page has no claimable line — the same gap as the fuzzer's alphabet, one
  level up. Carried over unchanged from the previous doc.
