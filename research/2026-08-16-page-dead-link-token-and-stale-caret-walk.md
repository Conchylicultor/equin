# The inline page-link token stopped parsing, and one e2e still counts keypresses

## Context

Two page-editor e2e drivers are red. The task framed them as possibly-related and
possibly-branch-introduced. Neither is true: they are **two independent root
causes, both on `main`**, and only one of them is a product bug.

The branch question is settled by git, not by a rebuild. This worktree is clean
and `git merge-base HEAD main == HEAD == 9980ea99e`, which is `main`'s tip — there
is no branch delta to attribute anything to. The prior investigation
(`research/2026-08-16-page-cmd-b-format-shortcut-double-dispatch.md:217`) had
already recorded `mark-boundary-verify.ts` phase 11 as "fails, pre-existing" and
reproduced it on `main` with a minimal probe. **No merge-base checkout, rebuild or
re-run is needed.**

What the prior investigation did *not* have is the cause. This plan has both.

---

## Defect 1 — the page-link token is pinned to an id format that no longer exists

### Evidence

`plugins/page/plugins/inline-page-link/core/tokens.ts:9`

```ts
export const PAGE_LINK_TOKEN_PATTERN = /\[\[(block-\d+-[a-z0-9]+)\]\]/;
```

That shape — `block-<epochMillis>-<base36>` — was retired by commit `53c4345f1`.
`plugins/page/plugins/editor/core/block-id.ts:32` now mints:

```ts
export function newBlockId(): string {
  return `block-${crypto.randomUUID()}`;
}
```

A uuid body never satisfies `\d+-[a-z0-9]+`. Measured, not reasoned:

```
block-2b45803b-6360-4fec-b10e-611cf21e83ab  ->  false
block-1718000000000-abc123                  ->  true
```

So **every inline page link minted since that commit is unparseable.** The same
file states the invariant that was broken (`block-id.ts:23`):

> *"Nothing parses this format, and nothing may start."*

The regex is a live violation of it, and nothing enforced the rule.

### Why no test caught it

Every fixture is pinned to a hand-written literal of the retired shape:

- `inline-page-link/web/internal/collab-roundtrip.test.ts:55` — `const pageId = "block-1718000000000-abc123"`
- `editor/core/inline-markdown.test.ts:302` — `const PAGE_TOKEN = /\[\[(block-\d+-[a-z0-9]+)\]\]/`
- `editor/e2e/mark-boundary-verify.ts:1133` — `const CHIP = \`[[${pageId}]]\``

The unit tests pass because they feed the parser exactly the format it still
expects. No test ever asked the real mint for an id. That is the actual gap, and
it is what the fix has to close.

### Blast radius (larger than one red e2e)

The pattern is consulted at every text→node boundary. Confirmed consumers:

| Consumer | Consequence today |
| --- | --- |
| `inline-page-link/web/internal/register.ts:15` (`deserializePattern`) | A block's content doc seeds the token as literal text — no chip |
| `inline-page-link/server/internal/extract-inline-links.ts` (`scanPageLinkTokens`) | **Backlinks are silently never indexed** for modern links |
| `inline-page-link/server/index.ts:16` (`Editor.InlineToken`) | The protected-span mask over inline markdown no longer covers the token |
| `read-only-view/web/components/runs-renderer.tsx:42` | History previews and diffs render a raw `[[block-…]]` string |

A chip inserted *right now* via the `[[` typeahead still looks fine, because the
node lives in the block's `Y.Doc` and reload reads the doc, not `data.text`. The
damage only shows where text is re-parsed: paste, markdown-apply, agent writes,
history restore, read-only rendering, and backlinks. That is what makes it silent.

Live data confirms the shape is real in production (`main` DB) and that neither
token carries a `page_links` edge:

```
page_blocks with a [[block-…]] token .... 2   (1 uuid-shaped, 1 legacy-shaped)
page_links edges for either .............. 0
```

### Fix — namespace the token (decided with the user)

Adopt the sibling precedent already in the codebase: `inline-date` stores
`[[date:<iso>]]` / `[[reminder:<id>:<iso>]]`, where a **prefix** disambiguates and
the body needs no shape constraint at all. Do the same for page links, so the id
goes back to being the opaque key `block-id.ts` says it is.

`plugins/page/plugins/inline-page-link/core/tokens.ts` — the single source of truth:

```ts
/**
 * Group 1 = the current namespaced form; group 2 = the pre-namespace form, read
 * only. The namespace is what lets the body stay unconstrained: an id is an
 * OPAQUE key (see editor/core/block-id.ts), and the retired pattern that
 * destructured one is exactly how inline links went dark.
 */
export const PAGE_LINK_TOKEN_PATTERN =
  /\[\[(?:page:([^[\]\n]+)|(block-\d+-[a-z0-9]+))\]\]/;

export const pageLinkToken = (pageId: string) => `[[page:${pageId}]]`;
```

`scanPageLinkTokens` pushes `m[1] ?? m[2]!`. Nothing else in that file changes.

Then the two match-group reads, both mirroring `inline-date/web/internal/register.ts:18-21`
byte-for-byte (it already branches on capture group for the same reason):

- `inline-page-link/web/internal/register.ts:16` — `createNodeFromMatch: (m) => $createPageLinkInlineNode(m[1] ?? m[2]!)`
- `read-only-view/web/components/runs-renderer.tsx` — same `m[1] ?? m[2]` read

`inline-page-link/server/index.ts` needs **no change**: `Editor.InlineToken` takes
one `RegExp` and the alternation covers both arms.

**Self-healing, no migration.** A live doc holds a real decorator node; the moment
that block is next edited, `serializeNode` writes the new `[[page:<id>]]` form
into `data.text` and the projection persists it. Per the user's decision there is
**no backlinks backfill** — reindex heals each page on its next edit, which for a
two-row problem is the right size.

**Accepted gap, stated rather than papered over:** a block whose `data.text` holds
a pre-namespace `[[block-<uuid>]]` token (unparseable then, unparseable now) still
renders literal text if its doc is ever re-seeded. There is exactly one such row
and it is this e2e's own leftover. Re-admitting uuid shape-parsing to rescue it
would reintroduce the defect being fixed.

### The guard that makes this class impossible

The rule is: **a fixture may never hand-write an id.** Three changes, each one
assertion:

1. `inline-page-link/core/tokens.test.ts` *(new)* — the mint-driven pin:
   ```ts
   test("the pattern matches a token built from a REAL id", () => {
     expect(PAGE_LINK_TOKEN_PATTERN.test(pageLinkToken(newBlockId()))).toBe(true);
   });
   ```
   Plus a legacy-literal case and a negative (`[[not a token]]`). This fails the
   day the mint changes again — which is the whole point.
2. `inline-page-link/web/internal/collab-roundtrip.test.ts:55` — `const pageId = newBlockId()`.
3. `editor/e2e/mark-boundary-verify.ts:1133` — `const CHIP = pageLinkToken(pageId)`,
   importing from `@plugins/page/plugins/inline-page-link/core`. An e2e may import
   another plugin's `core` barrel, and this makes the fixture track the format for
   free. Its surrounding comment (lines 1124-1130) still describes the mechanism
   correctly and needs no edit.

`newBlockId` is already exported from `@plugins/page/plugins/editor/core:119`.

### Separable second half — `active-data`'s bare-id pattern is dead the same way

`plugins/active-data/plugins/page-link/web/internal/pattern.ts:8`

```ts
export const BLOCK_ID_RE = inlineBoundary(/block-\d+-[a-z0-9]{4,8}/);
```

Same retired shape, so a block id an agent mentions in assistant prose no longer
linkifies. Its comment ("Client-minted content blocks carry UUIDs, which are
deliberately NOT matched") is obsolete — *all* ids are uuid-shaped now.

This one genuinely needs a shape pattern: it matches a **bare** id in free text
with no delimiter, so namespacing cannot help it. Widen to
`inlineBoundary(/block-[0-9a-z]+(?:-[0-9a-z]+)+/)`, rewrite the comment, and pin
it with the same mint-driven assertion. That plugin already imports
`@plugins/page/plugins/editor/core` (`web/components/page-link-chip.tsx:10`), so
`newBlockId` costs no new edge.

Drop this section if you want the change kept to the page editor; it is the same
root cause but a different surface.

---

## Defect 2 — `crdt-split-merge-verify.ts` counts keypresses, and one is absorbed

**This is a stale driver, not a product bug.** No production code changes.

The fixture types `alpha ` + bold `boldy` + …, then presses `ArrowRight` nine
times from offset 0 intending to split after `alpha bol`. That assumption predates
the mark-boundary virtual-delimiter feature (`59cbc6bf1`), which by design makes
one press at a mark seam *arm the pending mark instead of moving the caret*:

- `web/internal/keystroke-intent.ts:613-622` — `ArrowRight` tries `markStepFor` first
- `web/internal/keystroke-intent.ts:292-307` — at the `alpha `|`boldy` seam it returns `{type:"markStep"}`
- `web/internal/mark-depth.ts:170-182` — `$markStep` records pending format and never touches offsets

So nine presses advance eight positions. `splitRuns` (`core/rich-text.ts:205-226`)
then cuts at `9-6=3`→`bol`/`dy` when given 9, and at `8-6=2`→`bo`/`ldy` when given
8. That single character accounts for **exactly the five failures**: head text,
tail text, head bold, tail bold, and the caret-at-join assertion whose three
hardcoded `(anchorText, anchorOffset)` pairs no longer match. The behaviour it
trips over is deliberate and covered green by `mark-boundary-verify.ts` phases 1-10.

### Fix — walk to a *verified* offset (decided with the user)

Replace press-counting with a bounded walk that presses until the **measured**
linear offset reaches the target, and assert the achieved offset before `Enter`.
A future caret-stop feature then costs this driver nothing, and a genuine caret
regression fails loudly at the fixture line instead of surfacing as a mysterious
one-character content diff.

New `plugins/page/plugins/editor/e2e/support/caret.ts`, holding two functions:

- `caretLinear(page)` — lifted verbatim from `mark-boundary-verify.ts:169-186`.
  This is the **third** copy (`backspace-indent-verify.ts` has one too, as that
  function's own doc-comment notes), which is precisely where the cmd-b work drew
  the line when it lifted `settledRuns` into `support/runs.ts`. Same precedent,
  same reason.
- `pressUntilOffset(page, target, { max })` — press `ArrowRight` until
  `caretLinear` reads `target`; throw naming both the target and the offset
  actually reached if the bound is hit.

Then in `crdt-split-merge-verify.ts` (lines ~101-125):

```ts
await pressUntilOffset(pageA, 9);
r.eq("fixture: the caret is at offset 9 before the split", await caretLinear(pageA), 9);
await pageA.keyboard.press("Enter");
```

Migrate `mark-boundary-verify.ts` and `backspace-indent-verify.ts` to import
`caretLinear` from `support/` rather than keeping their local copies — mechanical,
and it is what stops a fourth copy appearing.

---

## Files

**Defect 1 — page editor**
- `plugins/page/plugins/inline-page-link/core/tokens.ts` — namespaced pattern + serializer
- `plugins/page/plugins/inline-page-link/core/tokens.test.ts` *(new)* — mint-driven pin
- `plugins/page/plugins/inline-page-link/web/internal/register.ts` — `m[1] ?? m[2]`
- `plugins/page/plugins/read-only-view/web/components/runs-renderer.tsx` — `m[1] ?? m[2]`
- `plugins/page/plugins/inline-page-link/web/internal/collab-roundtrip.test.ts` — `newBlockId()`
- `plugins/page/plugins/editor/core/inline-markdown.test.ts:302` — compose the shared pattern
- `plugins/page/plugins/editor/e2e/mark-boundary-verify.ts:1133` — `pageLinkToken(pageId)`
- Comments naming the old token in `markdown-apply/server/internal/{block-doc-text,runs-splice}.ts`
  and `inline-page-link/{core/tokens.ts,server/index.ts,web/**}` headers
- `plugins/page/plugins/inline-page-link/CLAUDE.md` — record the namespace and why

**Defect 1 — separable second half**
- `plugins/active-data/plugins/page-link/web/internal/pattern.ts` (+ its own mint-driven pin)

**Defect 2 — e2e only**
- `plugins/page/plugins/editor/e2e/support/caret.ts` *(new)*
- `plugins/page/plugins/editor/e2e/crdt-split-merge-verify.ts`
- `plugins/page/plugins/editor/e2e/{mark-boundary,backspace-indent}-verify.ts` — import the lifted helper

---

## Verification

1. `./equin test plugins/page/plugins/inline-page-link` — the new mint-driven
   pin must be **red before** the `tokens.ts` change and green after. Run it against
   the unfixed pattern once, so it cannot pass vacuously.
2. `./equin test plugins/page` and `./equin test plugins/active-data`.
3. `./equin build` (background — per the workflow rule) then, in order:
   - `bun plugins/page/plugins/editor/e2e/mark-boundary-verify.ts` — phase 11's
     `decoratorCount` goes 0 → 1 and 11c/11d/11e turn green; phases 1-10 unchanged.
   - `bun plugins/page/plugins/editor/e2e/crdt-split-merge-verify.ts` — 16/16.
   - `bun plugins/page/plugins/editor/e2e/inline-format-verify.ts` (39) and
     `format-shortcuts-verify.ts` (27) — the untouched nets, still green.
4. By hand at `http://<worktree>.localhost:9000` → Pages:
   - `[[` typeahead → pick a page → chip renders; reload → chip survives.
   - Copy that block, paste it into another page → **the chip renders in the
     pasted block** (this is the user-visible bug being fixed).
   - `query_db` the pasted block: `data.text` holds `[[page:<id>]]`, and
     `page_links` now carries the edge.
5. `./equin check`.

## Out of scope, deliberately

- No backlinks backfill (your call) — reindex heals a page on its next edit.
- No re-run against the merge-base: git already proves `HEAD == main`.
- No change to split/merge/offset production code — `splitRuns` is correct.
- No lint rule banning id-shape regexes. The mint-driven assertions are the
  cheaper guard for the two shape-parsing sites that remain; worth revisiting only
  if a third appears.
