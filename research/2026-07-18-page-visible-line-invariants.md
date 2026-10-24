# Page editor: visible-line invariants for Enter / Backspace

## Context

Two user-reported bugs exposed a class of subtle keystroke defects in the block editor:

1. **Split with children jumps.** `AAA|CCC` with expanded child `BBB`: Enter mid-text places the tail as the origin's *next sibling*, which renders **after the whole subtree** (`AAA / BBB / CCC`) instead of the expected `AAA / CCC / BBB-under-CCC`. Split and merge are not inverses today (Enter-then-Backspace lands in `BBB`, not back in `AAA`).
2. **Backspace ladder order is wrong.** At the start of an indented bullet, the current order is outdent → convert-to-text; the comment claims it "matches Notion" — it doesn't, and a unit test pins the wrong order.

Root cause, both times: operations are defined in **sibling space** (`parentId`+`rank`) while the user's mental model — and the caret's — is the **visible line sequence**. The codebase already derives document order everywhere else (merge via `prevVisibleLeaf`, the indent/outdent folds, `pasteAnchorId`); split and the keystroke ladders are the stragglers. The fix is to state the invariants once and derive behavior from them, replacing per-case patches.

Out of scope (follow-up tasks): forward-delete (Delete key) as Backspace's mirror; Enter-at-start identity preservation (insert-empty-above instead of moving the text to a new block id).

## The principles (go verbatim into doc comments + editor CLAUDE.md)

- **Split/merge invariant:** *Split turns one visible line into two adjacent visible lines: the tail becomes the immediately-next visible line; no other line changes position or depth. Merge is its exact inverse.*
- **Backspace principle:** *Backspace deletes the nearest visible thing to the LEFT of the caret:* marker glyph (convertTo) → indentation (outdent) → line break (merge) → boundary (nav-left).
- **Empty-Enter principle:** *Empty-Enter escapes one structural level per press:* indentation first (outdent, keeping the type), then the type (convertTo), then ordinary split.

The two ladders order convertTo/outdent **oppositely, deliberately** (Backspace: the marker is visually nearest the caret; Enter: escapes nesting outward).

## Design decisions

### 1. Split adoption — reducer-derived, not op-carried

In `applySplit`'s non-asChild arm (`plugins/page/plugins/editor/core/block-ops.ts:373-392`): when the origin has **visible** children (`block.expanded && childrenOf(...).length > 0`), the new tail block **adopts all of them** (reparent to `op.newId`, **ranks preserved byte-for-byte** — the whole sibling set moves), and the tail gets `expanded: true`. Collapsed children are not visible lines and stay with the head.

Why derived from state inside the reducer (no new op flag):

- Ops apply against the **current** forest — overlay replays onto refreshed bases, the server applies against its own load. A flag frozen at intent time could contradict the forest at application time (e.g. a racing collapse). Deriving keeps the invariant true *at the moment the op is applied*.
- Byte-identical client/server by construction; uniform for every caller (keyboard, memory store, tests, fuzz).
- Mirrors how `applyMerge` (`:424-441`) already derives adoption from state — that symmetry is what makes the round-trip property provable: after an adoption-split the head is childless, so `prevVisibleLeaf(tail)` resolves to the head and merge re-adopts.

Pinned specifics: head keeps `expanded: true` with zero children (harmless — no chevron without children; deliberate, tested); asChild branch untouched (toggles structurally exempt via `splitChildWhenExpanded`); position-0 split → empty head above, tail carries text + children; adoption + `siblingType` combo is UI-unreachable but reducer-legal (tail takes the type AND adopts — tested); adopted set may contain sub-page rows (same-page leaf reparent, legal, mirrors merge); `opBlockIds` split case stays `[blockId, newId]` (documented under-approximation — adopted children are unnamed side-effect rows exactly like merge's rewritten target; less cascading, never a wrong drop).

**Zero changes needed** in: server op handler (`reconcileBlocks` picks up reparented children as ordinary updates), undo recording (`diffBlocks`/`patchesFromDiff` over full snapshots), overlay confirm (`{kind:"create", id:newId}`), the deferred `truncateAt` doc surgery (origin-only, orthogonal).

### 2. Keystroke ladders (`web/internal/keystroke-intent.ts`)

**Backspace** (`:120-136`) new order: `convertTo` (if `resetToOnBackspaceAtStart` && type differs) → `outdent` (if indented) → `merge` (if prev sibling) → `nav left`. Replace the false "matches Notion" comment with the principle.

**Empty-Enter** (`:94-104`): for an empty block (atStart && atEnd) whose policy declares `breakOutOnEmptyEnter`: if indented → `outdent` (keep type); at top level and type ≠ target → `convertTo`; else fall through to split. Plain blocks without the policy are unaffected.

Decision matrices (pinned as tests):

| Backspace: reset-policy&&type≠target | indented | hasPrev | intent |
|---|---|---|---|
| 1 | * | * | convertTo |
| 0 | 1 | * | outdent |
| 0 | 0 | 1 | merge |
| 0 | 0 | 0 | nav left |

| Empty-Enter: breakOut policy | indented | type≠target | intent |
|---|---|---|---|
| 1 | 1 | * | outdent |
| 1 | 0 | 1 | convertTo |
| 1 | 0 | 0 | split |
| 0 | * | * | split |

### 3. `dataOnSplit` seam (checked to-do splits into unchecked tail)

- **Handle** (`core/define-block.ts`): `dataOnSplit?(data: T): T` — **method syntax required** (bivariance; same trap `text` documents at `:49-53` — property syntax breaks `BlockHandle<unknown>` registry assignability). Mirrored opts entry + passthrough.
- **Op** (`core/block-ops.ts`): split variant gains `tailData?: unknown`; `BlockOpSchema` gains `tailData: z.unknown().optional()`. Reducer: tail data = `{...(op.tailData ?? block.data), text: afterRuns}`; absent = inherit (today's behavior). Bad payloads are caught by the existing strict `parseBlockData` at the server write boundary (loud 400).
- **Resolution in the resolver** (not the executor): `IntentContext.editPolicy` gains `dataOnSplit`; the split `KeyIntent` gains `tailData`. Guard: apply the transform **only when the tail type === origin type** (a heading→text end-split must not run the heading's transform against the text schema). Reading `node.data` is safe — only `data.text` lags the live doc, and it's overwritten by `afterRuns`.
- **Wiring:** `keyboard-plugin.tsx:143-157` (editPolicy assembly + executor pass-through), `web/types.ts` + `block-editor-context.tsx:985-1031` (split opts → op). `api.split` is the **sole** split producer (verified).
- **To-do** (`plugins/page/plugins/to-do/core/to-do-block.ts`): `dataOnSplit: (d) => ({ ...d, checked: false })`.

## Tests

`core/block-ops.test.ts` (reuse `mk`/`run`/`ids` + `rng`/`randomForest`):
1. Mid-text split, expanded parent, 2 children → tail immediately after head; children under tail, ranks byte-equal, order preserved; tail `expanded: true`; head keeps `expanded: true` (pinned).
2. Collapsed parent → children stay with head; tail childless, `expanded: false`.
3. `expanded: true`, zero children → plain sibling split.
4. Position-0 split with children → empty head, tail carries text + children.
5. Adoption + siblingType (pure-reducer combo).
6. asChild with expanded children → unchanged, no sibling adoption.
7. Adopted set containing a sub-page row → moves under tail, pageId unchanged.
8. `tailData` present → transform result + `text: afterRuns`; head untouched.
9. `tailData` absent → inherited spread pinned (`checked: true` carries).
10. **Round-trip property** (~500 seeds): random content block, random position → split, then merge on `newId` → **structural equality** vs original (canonical `{parentId, type, expanded, childIds order, coalesced runs}` per id — never rank strings; merge mints fresh ranks). Plus direct `mergeRuns(...splitRuns(runs,p)) === coalesce(runs)`.
11. Chain fuzz: `randomOp` split case sometimes carries `tailData`.
12. Existing page-row property tests stay green unmodified.

`web/internal/keystroke-intent.test.ts`:
- Flip `:228` (indented formatted → convertTo first); full matrix rows for both keys; empty-Enter indented variants; `:190/:196/:202/:219/:245` unchanged (verify, don't touch).
- Trajectory tests (evolve fixture via `applyBlockOp`/type-swap, re-resolve): formatted nested → `[convertTo, outdent, merge]`; plain depth-2 → `[outdent, outdent, merge]`; empty bullet depth-2 → `[outdent, outdent, convertTo, split]`; empty plain indented (no policy) → `[split]`.
- `tailData` resolver: present iff tail type === origin type; absent under siblingType / differing childType.

## Docs

New section "**Visible-line invariants (Enter / Backspace)**" in `plugins/page/plugins/editor/CLAUDE.md` (before the autogen block): the split/merge invariant + adoption rule and why reducer-derived; merge as exact inverse with the round-trip test named as executable spec; both ladder principles + the deliberate opposite ordering; the `dataOnSplit` seam and why the op carries `tailData`; one sentence on the `opBlockIds` under-approximation.

## Task breakdown (contract fixed upfront so A ∥ B)

Shared contract: op field `tailData` (`z.unknown().optional()`), intent field `tailData?: unknown`, editPolicy field `dataOnSplit`, handle method `dataOnSplit?(data: T): T` (method syntax).

- **Task A — core reducer (load-bearing, Opus):** adoption + `tailData` in `core/block-ops.ts`; tests 1-12 in `core/block-ops.test.ts`.
- **Task B — intent + web wiring (load-bearing, Opus):** both ladders + resolver `tailData` + all keystroke-intent tests; `keyboard-plugin.tsx`, `web/types.ts`, `block-editor-context.tsx`, `core/define-block.ts`, to-do declaration.
- **Task C — docs (Sonnet), after A+B.**
- **Task D — e2e verification (Sonnet), after A+B + build.**

## Verification

1. `bun test plugins/page/plugins/editor` (both pure suites; after build/`bun install`).
2. `./equin build` → app at `http://<worktree>.localhost:9000`.
3. New `e2e/visible-line-verify.mjs` modeled on `e2e/crdt-split-merge-verify.mjs`: (a) AAA + expanded child BBB, Enter mid-AAA → DOM order/depth = head / tail / BBB-under-tail; (b) nested bullet, repeated Backspace at start → marker gone → outdented → merged; (c) empty nested bullet + Enter → still a bullet, one level up. Screenshots each step.
4. Manual smoke: split a checked to-do → tail unchecked; Cmd+Z after adoption split → children return under head in one undo.

## Risks

- Stale `expanded: true` on post-adoption head — harmless, pinned by test as a decision.
- `dataOnSplit` must be method-syntax (registry assignability) — in the contract.
- Intent-test assertions gain a `tailData` key — pick `toMatchObject` vs explicit `tailData: undefined` consistently.
- Zod strips unknown keys → `tailData` degrades to inherit against an old server (deploy-together; transient cosmetic only).
