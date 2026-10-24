# Ban raw scroll writes; migrate hand-rolled scroll idioms to sanctioned primitives

## Context

The `no-adhoc-scroll-into-view` lint rule (in the `scroll-reveal-safety` lint
plugin) bans raw `element.scrollIntoView(...)` and routes "reveal an element on
activation" through the `scroll-reveal` primitive. But it deliberately matches
**only** `scrollIntoView`/`scrollIntoViewIfNeeded` — the sibling raw-write APIs
`el.scrollTop = …`, `el.scrollLeft = …`, and `el.scrollTo(…)` were left
unguarded. As a result the **bottom-pin / auto-follow idiom** — which has a
sanctioned owner (`auto-scroll`'s `useStickyScroll`) — is still hand-rolled in
four consumer sites. These hand-rolls can fight the user's scroll exactly the way
the `scrollIntoView` class did before it was banned.

**Goal:** migrate every hand-rolled scroll write to a sanctioned primitive, then
close the loophole structurally — extend the lint plugin so raw scroll writes are
banned outside the scroll-owning primitives, so this whole class can never
reappear.

### Complete blast radius (repo-wide audit)

Raw scroll writes outside the primitive — every site, confirmed by
`rg '\.(scrollTop|scrollLeft)\s*=[^=]'` and `rg '\.(scrollTo|scrollBy)\('` across
`plugins/`, `web/`, `cli/` (only `plugins/` had hits):

| # | Site | Write | Semantics |
|---|------|-------|-----------|
| 1 | `plugins/debug/plugins/logs/web/components/log-viewer.tsx:133` | `scrollTop = scrollHeight` | true bottom-pin (already pin-tracks) |
| 2 | `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/message-toc/web/components/message-toc.tsx:120` | `scrollTo({top: scrollHeight})` | imperative jump-to-bottom on button click |
| 3 | `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-progression/web/components/chord-progression.tsx:154` | `scrollTo({top})` | center active bar on playhead advance (reveal-on-activation) |
| 4 | `plugins/layouts/plugins/miller/web/components/miller-columns.tsx:34` | `scrollLeft = scrollWidth` | reveal newest (rightmost) column on chain growth |
| — | `plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts:47,62,86,96` | scrollTop/scrollTo | **the primitive itself → allowlist** |

Sites 1–4 migrate; the primitive is allowlisted. Site 4 (`scrollLeft`,
horizontal) is not one of the three originally named but is the same class, so
it is included.

### Decisions (confirmed with user)

- **chord-progression → `scroll-reveal`.** It is a reveal-on-activation pattern,
  not bottom-stick. `useRevealOnActive` fires only on the active-bar *transition*,
  which is precisely "playhead crosses a bar boundary" — and by design never
  fights the user's scroll.
- **Lint scope = full class.** Ban `scrollTop=`/`scrollLeft=` assignments **and**
  `scrollTo()`/`scrollBy()` calls repo-wide (incl. the horizontal site 4).
- **Rule home = rename plugin to `scroll-safety`.** The plugin becomes the home
  for both `no-adhoc-scroll-into-view` and the new `no-adhoc-scroll-write`.

## Sanctioned primitives (reused, not reinvented)

- `auto-scroll` — `plugins/primitives/plugins/auto-scroll/web/`
  - `useStickyScroll({ threshold?, forceScrollKey?, resetKey? }) →
    { scrollRef, isPinned, hasUnread, jumpToBottom, scrollIfPinned }`. Attach
    `scrollRef` to the scroll viewport; call `scrollIfPinned()` from an effect
    keyed on content length. Model consumers: `build-log-section.tsx`,
    `jsonl-pane.tsx`.
  - **New:** `scrollToBottom(el, opts?)` imperative funnel (see Part A).
- `scroll-reveal` — `plugins/primitives/plugins/scroll-reveal/web/`
  - `useRevealOnActive(isActive, opts?: RevealOptions & { revealOnMount? }) →
    (el) => void` (callback ref). Reveals on false→true transition only.
  - `revealElement(el, opts?: { behavior?, block?, inline? })` — imperative funnel
    wrapping `scrollIntoView` (defaults `block/inline: "nearest"`).

## Part A — Add the `scrollToBottom` imperative funnel to `auto-scroll`

Site 2 (`message-toc`) is a floating overlay that resolves the pane's scroll
container imperatively at click time (`paneScrollFrom` DOM walk) — it does not
own the scroll ref, so it cannot use the `useStickyScroll` hook. It needs an
imperative "scroll this located container to its bottom" funnel — the bottom-pin
analog of `scroll-reveal`'s `revealElement`.

New file `plugins/primitives/plugins/auto-scroll/web/scroll-to-bottom.ts`:

```ts
export interface ScrollToBottomOptions {
  behavior?: ScrollBehavior; // default "auto"
}

/** Imperative sanctioned funnel: scroll a container to its bottom edge. The
 * bottom-pin analog of scroll-reveal's revealElement — for callers that hold an
 * element but not a mounted useStickyScroll handle. */
export function scrollToBottom(
  el: HTMLElement | null | undefined,
  opts?: ScrollToBottomOptions,
): void {
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: opts?.behavior ?? "auto" });
}
```

- Re-export from `plugins/primitives/plugins/auto-scroll/web/index.ts`
  (`export { scrollToBottom } from "./scroll-to-bottom"; export type
  { ScrollToBottomOptions } …`).
- Optional single-sourcing: have `useStickyScroll`'s `jumpToBottom` call
  `scrollToBottom(el, { behavior: "smooth" })`. The three `scrollTop = scrollHeight`
  writes there are pre-paint/instant and stay as-is (already inside the
  allowlisted file). Not required for correctness — keep the diff minimal if
  preferred.

## Part B — Migrate the four sites

### Site 1 — `log-viewer.tsx` (bottom-pin → `useStickyScroll`)

Cleanest 1:1 mapping. Replace `viewportRef` + `stickToBottomRef` + the two manual
effects (the scroll listener at 116–127 and the `[entries]` scroll effect at
129–134) with:

```tsx
const { scrollRef, scrollIfPinned } = useStickyScroll({ threshold: 32 });
useEffect(() => { scrollIfPinned(); }, [entries, scrollIfPinned]);
```

- Attach `ref={scrollRef}` to the existing `<Scroll fill …>` (line 208–212).
- `threshold: 32` preserves the current 32px pin distance (primitive default is
  50). Channel-switch reset is already handled by the parent remounting
  `LogChannelView` keyed on `selectedKey`, so no `resetKey` needed.
- Optional enhancement: add a `<JumpToBottomButton handle={{ isPinned, hasUnread,
  jumpToBottom }} />` (the primitive gives it for free; the current hand-roll has
  no jump affordance). Keep out of scope unless desired.

### Site 2 — `message-toc.tsx` (imperative jump → `scrollToBottom`)

Only the footer button (116–127) writes raw scroll. Replace:

```tsx
onClick={(e) => {
  const container = paneScrollFrom(e.currentTarget);
  scrollToBottom(container, { behavior: "smooth" });
}}
```

`paneScrollFrom` and the row-click `revealElement` (already sanctioned
scroll-reveal usage) are untouched. No behavior change — this is the same jump,
routed through the funnel.

### Site 3 — `chord-progression.tsx` (center active bar → `useRevealOnActive`)

Move the reveal into the row. Delete the parent-level `scrollRef` scroll effect
(148–154) and the `container.scrollTo`. In `BarRow`, derive active-bar state and
attach the reveal callback ref:

```tsx
// parent: pass whether this row is the active bar
<BarRow key={i} isActiveBar={i === activeBar} … />

// BarRow:
const revealRef = useRevealOnActive(isActiveBar, {
  block: "center",
  behavior: "smooth",
});
// merge revealRef with the existing rowRefs callback ref
```

- The existing `rowRefs.current[i] = el` callback ref must be **merged** with
  `revealRef` (both are callback refs — call both in one `ref={(el) => { rowRefs…;
  revealRef(el); }}`), since `rowRefs` may still be used elsewhere; if `rowRefs`
  becomes unused after removing the parent effect, drop it entirely.
- `scrollRef` on the container `<div>` is no longer needed for scrolling; keep the
  bounded `overflowY:auto` container (it is the scroll parent
  `scrollIntoView` acts on).
- **Verify (see Verification):** `revealElement` uses `scrollIntoView`, which
  scrolls the *nearest scrollable ancestor* (the bounded container) and, if any
  outer ancestor is scrollable, could nudge it too. `block: "center"` only moves
  what is needed. The pane is bounded, so the page should not move — confirm in
  the running app.

### Site 4 — `miller-columns.tsx` (reveal newest column → `revealElement`)

Keep the existing container `ref` and the `len > lastLength` growth guard
(31–37); replace the raw write body with a reveal of the newest column (the
container's last flex child):

```tsx
useLayoutEffect(() => {
  const len = match?.panes.length ?? 0;
  if (ref.current && len > lastLength.current) {
    revealElement(ref.current.lastElementChild, { inline: "end", block: "nearest" });
  }
  lastLength.current = len;
}, [match?.panes.length]);
```

- `inline: "end"` aligns the newest column's right edge with the container end —
  the same "scroll fully right to reveal the new column" effect as
  `scrollLeft = scrollWidth`, without a raw write. `block: "nearest"` avoids
  vertical movement.
- No ref plumbing into `SortableItem` children needed — `lastElementChild` off the
  container `ref` is the newest column wrapper.

## Part C — Extend the lint plugin

### C1. Rename the plugin `scroll-reveal-safety` → `scroll-safety`

Directory: `plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-reveal-safety/`
→ `…/scroll-safety/`.

- Rename the folder; update the `name:` field in `lint/index.ts` default export
  from `"scroll-reveal-safety"` to `"scroll-safety"`.
- Update `package.json` `name` if it embeds the folder name.
- Update `CLAUDE.md` prose.
- The generated lint registry
  (`plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts`) and
  the plugin docs (`docs/plugins-compact.md`, `docs/plugins-details.md`, per-plugin
  `CLAUDE.md` autogen block) are **regenerated by `./equin build`** — do not
  hand-edit. The `plugins-registry-in-sync` / `plugins-doc-in-sync` checks verify
  the regen.

### C2. Add rule `no-adhoc-scroll-write`

New file
`plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-safety/lint/no-adhoc-scroll-write.ts`
(same `ESLintUtils.RuleCreator` shape as `no-adhoc-scroll-into-view.ts`). Match:

- **`AssignmentExpression`** whose `left` is a `MemberExpression` with a
  non-computed `property` Identifier named `scrollTop` or `scrollLeft` (writes
  only — **reads** like `el.scrollHeight - el.scrollTop - el.clientHeight` are a
  `MemberExpression` not an assignment target, so they are not flagged).
- **`CallExpression`** whose `callee` is a `MemberExpression` with property
  Identifier `scrollTo` or `scrollBy`.

Message (points at both scroll-owning primitives so the reader picks the right
one):

> Raw scroll writes (`scrollTop=`/`scrollLeft=`/`scrollTo`/`scrollBy`) are banned
> outside the scroll-owning primitives. For stick-to-bottom / jump-to-bottom use
> `useStickyScroll` / `scrollToBottom` from
> `@plugins/primitives/plugins/auto-scroll/web`. For reveal-an-element-on-
> activation use `useRevealOnActive` / `revealElement` from
> `@plugins/primitives/plugins/scroll-reveal/web`. If you have a genuinely
> different need, extend those primitives rather than copying them.

### C3. Register the rule + allowlist

In `…/scroll-safety/lint/index.ts`:

```ts
import noAdhocScrollIntoView from "./no-adhoc-scroll-into-view";
import noAdhocScrollWrite from "./no-adhoc-scroll-write";

export default {
  name: "scroll-safety",
  rules: {
    "no-adhoc-scroll-into-view": noAdhocScrollIntoView,
    "no-adhoc-scroll-write": noAdhocScrollWrite,
  },
  ignores: {
    "no-adhoc-scroll-into-view": [
      "plugins/primitives/plugins/scroll-reveal/web/internal/use-reveal-on-active.ts",
    ],
    "no-adhoc-scroll-write": [
      "plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts",
      "plugins/primitives/plugins/auto-scroll/web/scroll-to-bottom.ts",
    ],
  },
};
```

- The `no-adhoc-scroll-write` allowlist contains **only scroll-owning primitive
  files** — no consumer is exempted (all four migrate). `scroll-reveal`'s
  `use-reveal-on-active.ts` is not listed: it writes via `scrollIntoView`, not
  `scrollTop`/`scrollTo`, so the write-rule never sees it.
- Note: the rule flags *any* receiver's `.scrollTo(`/`.scrollBy(` including a
  hypothetical `window.scrollTo` (page scroll). None exist today; if one is later
  needed it should be reviewed, so matching all receivers is intentional.

### C4. (New) Tests

`no-adhoc-scroll-into-view` currently ships **no** test. Add
`no-adhoc-scroll-write.test.ts` next to the rule (bun:test + `RuleTester`,
mirroring e.g. `git-grep-safety/lint/no-adhoc-git-grep.test.ts`): valid cases
(reads `x = el.scrollTop`; `el.scrollHeight`; `foo.scrollToTop()`), invalid cases
(`el.scrollTop = h`, `el.scrollLeft = w`, `el.scrollTo({top})`, `el.scrollBy(…)`).

## Files to modify

**New**
- `plugins/primitives/plugins/auto-scroll/web/scroll-to-bottom.ts`
- `…/lint/plugins/scroll-safety/lint/no-adhoc-scroll-write.ts` (+ `.test.ts`)

**Edit**
- `plugins/primitives/plugins/auto-scroll/web/index.ts` (export funnel)
- `plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts` (optional single-source)
- `plugins/debug/plugins/logs/web/components/log-viewer.tsx` (site 1)
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/message-toc/web/components/message-toc.tsx` (site 2)
- `plugins/apps/plugins/sonata/plugins/rich/plugins/chord-progression/web/components/chord-progression.tsx` (site 3)
- `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` (site 4)

**Rename**
- `…/lint/plugins/scroll-reveal-safety/` → `…/lint/plugins/scroll-safety/`
  (folder, `lint/index.ts` `name`, `package.json`, `CLAUDE.md`)

**Regenerated by build (do not hand-edit)**
- `…/lint/core/lint.generated.ts`, `docs/plugins-compact.md`,
  `docs/plugins-details.md`, autogen `CLAUDE.md` blocks.

## Verification

1. `./equin build` — regenerates the lint registry + docs and restarts the
   server. Confirm build is clean (regen picks up the rename).
2. `./equin check` — runs `type-check` (incl. the ESLint pass with the new
   rule) + `plugins-registry-in-sync` + `plugins-doc-in-sync`. The new rule must
   report **zero** violations (all four sites migrated, primitive allowlisted).
3. Grep guard: `rg '\.(scrollTop|scrollLeft)\s*=[^=]|\.(scrollTo|scrollBy)\('
   plugins` should return **only** `auto-scroll/web/use-sticky-scroll.ts` and
   `auto-scroll/web/scroll-to-bottom.ts`.
4. `bun test plugins/framework/plugins/tooling/plugins/lint/plugins/scroll-safety`
   — the new rule's RuleTester cases pass.
5. Manual, in `http://<worktree>.localhost:9000`:
   - **Logs** (Debug → Logs): open a live channel; new lines auto-stick to bottom;
     scroll up and confirm it stops auto-sticking; scroll back down and it re-pins.
   - **Chord progression** (Sonata rich lead-sheet): play a song; the active bar
     stays centered as the playhead advances; **confirm the page/pane itself does
     not scroll** (only the lead-sheet strip) — the key risk of moving off
     `container.scrollTo` to `scrollIntoView`.
   - **Miller columns**: drill into nested panes (e.g. Tasks → open several
     columns); each new column scrolls into view on the right.
   - **message-toc**: open a jsonl conversation with the TOC overlay; click the
     footer chevron → jumps to the bottom of the correct pane.

## Risks / caveats

- **chord-progression ancestor-scroll:** the one behavior-change risk.
  `scrollIntoView` (via `revealElement`) may scroll an outer ancestor if one is
  scrollable, unlike the original container-only `scrollTo`. `block:"center"`
  minimizes movement and the pane is bounded, but verify step 5 explicitly. If the
  page does move, fall back to keeping chord-progression on a container-scoped
  scroll and instead extend a primitive with a "center child within its own scroll
  container" mode (the deferred "extend a primitive" option) — do **not** exempt
  the consumer.
- **Lint rename churn** is mechanical and regenerated by build; the two in-sync
  checks catch any drift.
