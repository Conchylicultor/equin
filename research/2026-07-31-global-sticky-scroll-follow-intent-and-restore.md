# Sticky scroll: follow-as-intent, visibility sensing, and persistent restore

## Context

Reported symptom, on `http://equin.localhost:9000/agents/c/<id>`: scroll to
the very bottom of a conversation, refresh, and the page lands several messages
*up* the transcript. Then the moment a new message arrives it snaps to the end.

Nothing is being restored. The pane is *trying* to jump to the bottom and
missing, and then lying about where it thinks you are. Three separate defects in
`plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts` compound:

1. **No persistence exists.** On mount a `useLayoutEffect` keyed on `resetKey`
   sets `el.scrollTop = el.scrollHeight` (lines 45-53). A refresh is not a
   restore — it is an unconditional jump to the bottom.
2. **The jump happens before layout settles.** Transcript rows keep growing
   after first paint: shiki highlighting resolves asynchronously with no sync
   path (`syntax-highlight/web/internal/use-highlighted-html.ts:114`), images
   load, lazy subtrees mount. `scrollTop` is an absolute pixel value, so once
   rows get taller the offset that *was* the bottom no longer is. The hook also
   sets `overflowAnchor = "none"` while it believes it is pinned (line 49),
   disabling the browser's own position stabilisation during exactly that
   window.
3. **Pin state is a phantom.** `isPinned` is derived *only* from scroll events
   (lines 67-80). The initial programmatic write fires one scroll event at which
   distance-to-bottom is genuinely `0`, so `isPinnedRef.current` latches `true`.
   Content then grows with no further scroll event, so the flag is never
   corrected. You are visually mid-transcript while the hook believes you are
   pinned — and `scrollIfPinned()` (`jsonl-pane.tsx:230-232`) obeys the stale
   flag on the next event.

The root cause under all three: **the hook infers whether you want to be at the
bottom instead of being told.** `research/2026-05-25-global-sticky-scroll-redesign.md`
removed a `ResizeObserver` from this hook for the same reason — a size delta is
sign-blind, so opening the file pane (column narrows, text rewraps taller) was
indistinguishable from new content and scrolled the user away. That change
removed the symptom but kept the inference.

### Decisions already taken by the user

- Persistence in `localStorage` with a **30-day TTL**, matching the existing
  `pane-restore` precedent.
- Restore on **both** refresh and in-app return to a conversation.
- Fix the primitive so all six consumers benefit; persistence itself is opt-in
  and enabled only on the transcript.

## Design

### 1. Replace the geometric pin with a visibility sentinel

The hook returns a zero-height `bottomSentinel` element that the consumer
renders as the **last child** of the scroll container. An `IntersectionObserver`
rooted at the scroll box answers "is the bottom on screen?" natively — no
`scrollHeight - scrollTop - clientHeight` arithmetic, and it re-fires by itself
as async content settles, which is precisely defect 2.

Why this cannot reproduce the 2026-05-25 file-pane bug, stated structurally:
**a size signal is sign-blind; a visibility signal is sign-asymmetric.** A
taller reflow can only push the content end further down, i.e. it can only make
the bottom *less* visible. A signal that can only ever un-follow cannot drag a
user to the bottom.

Be honest in the code comments about the converse: while `following` is true, a
reflow *does* cause a scroll write (that is what a tail-follower is for). The
guarantee is "no observation-driven writes **while not following**", not "no
observation-driven writes".

Two sentinel details that are easy to get wrong:

- **`rootMargin`, not `threshold`.** A zero-height node with `threshold: 0`
  intersects only at distance ≤ 0. The existing pin distance survives as
  `rootMargin: "0px 0px ${threshold}px 0px"` (default 50, `log-viewer` 32).
- **`position: sticky; left: 0; width: 1px`.** `jsonl-pane` uses `axis="both"`.
  A plain block sentinel is anchored at `left: 0` of the content box, so
  scrolling right past a wide code block would scroll it out of the horizontal
  viewport and spuriously drop `following`.

Do not render the sentinel inside `EventSections`' `<Stack gap="sm">` — a
zero-height flex child still consumes a gap.

### 2. Follow is an intent, detected as "a scroll I did not author"

`following` starts `true` (or is restored), and flips only on a scroll the hook
did not perform:

```ts
// after every own instant write:
lastWrittenTopRef.current = el.scrollTop;   // read back, to absorb clamping

onScroll: if (el.scrollTop !== lastWrittenTopRef.current) {
  following = sentinelVisibleRef.current;   // away ⇒ stop; back at bottom ⇒ resume
}
```

Do **not** use gesture listeners (`wheel`/`touchmove`/keys). They miss scrollbar
drags, find-in-page, middle-click autoscroll, native drag-select autoscroll, the
repo's own `useEdgeAutoScroll` and `scrollChildIntoView`, and — critically —
`revealElement`, which `StickyUserHeader` calls on expand
(`jsonl-pane.tsx:93-95`). Under a gesture model, expanding a pinned header while
at the bottom would leave `following` true and instantly undo the reveal.

Keep **all follow writes instant**; only user-initiated `jumpToBottom` uses
`behavior: "smooth"`, and it sets `following = true` explicitly rather than
relying on the scroll comparison (a smooth scroll emits intermediate offsets
that never equal the target).

### 3. API change

```ts
useStickyScroll({ threshold?, followKey?, persist? })
  → { scrollRef, bottomSentinel, isFollowing, jumpToBottom }
```

- **`resetKey` is deleted.** Its job — "fresh stream ⇒ bottom" — is now the
  mount default. Four consumers pass a constant; `jsonl-pane` passes
  `conversation.id`, which is already redundant because `PaneResolveGuard` keys
  the subtree on `resolveIdentity(paneId, params)` and fully remounts the pane
  on a `convId` change.
- **`forceScrollKey` is replaced by `followKey`.** Changing it re-asserts
  `following = true`. `jsonl-pane` passes `pendingTurns.length`, not
  `isWorking`: "the user just sent a turn" is a real intent signal, whereas
  `isWorking` also rises when a *background* agent resumes, which should not
  yank a reading user to the bottom.
- **`hasUnread` is dropped.** `scrollIfPinned()` was its only writer (line 90),
  and an IO sentinel cannot know content arrived. `JumpToBottomButton`'s
  null-check (`jump-to-bottom-button.tsx:31`) collapses to
  `if (isFollowing) return null`, so the button now shows whenever you are away
  from the bottom. Re-introducing unread would mean re-introducing a per-consumer
  content signal — the exact coupling being deleted.
- **`scrollIfPinned` is deleted**, along with the `useEffect` on content length
  in all six consumers.

Enforce the sentinel placement rather than documenting it: in the mount layout
effect, assert it is a descendant of `scrollRef.current` and last in document
order, and **throw** otherwise (fail-loudly rule). A forgotten sentinel must not
degrade silently into "never follows".

### 4. Persistence: a discriminated mode, keyed on content identity

Restore and follow are not two features racing — they are one state, persisted:

```ts
type ScrollMode =
  | { kind: "following" }
  | { kind: "anchored"; key: string };
```

Restoration returns a typed result, never an absorbable `null`
(`no-absorbed-failure`):

```ts
type RestoreOutcome =
  | { kind: "none" }                     // nothing saved, or TTL-expired
  | { kind: "following" }
  | { kind: "anchored"; el: HTMLElement }
  | { kind: "missing"; key: string };    // saved, but the row is gone
```

`missing` clears the stale record and falls back to `following`; it is
distinguishable from `none` so a systematic key regression is visible rather
than silently reading as "first visit".

**Do not persist `data-event-index`.** It is the index into the *filtered*
array (`visibleEvents`, `jsonl-pane.tsx:191-195`, stamped at `:127-136` →
`event-row.tsx`), so it shifts whenever the `JsonlViewer.EventFilter` set
changes, whenever the transcript is compacted, and whenever a chain refresh
prepends an earlier session's lines. Persist content identity instead: a new
`data-event-key` stamped by `EventRow`, derived from a shared
`eventKey(event)` — `toolUseId` where present (already the React key,
`jsonl-pane.tsx:131`), otherwise `` `${kind}:${at}` ``. Two events sharing kind
and timestamp collide and land on a neighbouring row; acceptable, and worth a
comment.

Scope the key on **(entity × surface tab)** via `useSurfaceTabId()`
(`primitives/surface-id`), mirroring `layouts/miller/use-column-widths.ts`.
Two panes can be open on the same conversation — `message-toc.tsx:48-50` exists
because of exactly that.

Reuse `useDraft` from `primitives/persistent-draft` (localStorage envelope,
TTL, cross-tab sync) rather than hand-rolling a third storage envelope the way
`pane-restore` did.

Restore scrolls via `revealElement` from `scroll-reveal` (the sanctioned
`scrollIntoView` funnel), so no new file needs adding to the
`no-adhoc-scroll-write` path allowlist — all raw writes stay inside the already
allowlisted `use-sticky-scroll.ts`.

### 5. Fix `message-toc` in the same pass

`message-toc` computes `eventIndex` over the **unfiltered** `result.data`
(`message-toc.tsx:26-36`) and queries `[data-event-index="${i}"]` (`:72`), while
that attribute is stamped over the filtered array. `ask-user-question`
contributes filters hiding `user-text` events
(`.../ask-user-question/web/index.ts:21-34`) — the exact kind the TOC lists. The
TOC therefore already navigates to the wrong message in any conversation
containing an AskUserQuestion answer. Migrate it to `data-event-key`: this is
both the fix and the demonstration that positional keys are unsafe.

### 6. Extract a pure reducer

jsdom ships no `IntersectionObserver`, so the state machine is otherwise
e2e-only. Mirror the `scrollClasses` / `pinClasses` / `stickyClasses` precedent
(each pure and separately tested):

```ts
type Signal =
  | { t: "sentinel"; visible: boolean }
  | { t: "foreign-scroll"; sentinelVisible: boolean }
  | { t: "jump" }
  | { t: "follow-key" };

reduce(mode: ScrollMode, s: Signal): ScrollMode
```

Also extract `sentinelObserverOptions({ threshold }) → { rootMargin, threshold }`
as a pure function, tested like `scrollClasses` is.

## Rejected alternatives

- **`flex-direction: column-reverse`** — genuinely fixes defects 2 and 3 with
  zero JS (scroll origin is the visual bottom, so tail growth never moves
  `scrollTop`). Rejected for the transcript: it requires inverting
  `EventSections`' DOM order and restructuring the `Sticky edge="top"` headers
  (`jsonl-pane.tsx:138-164`), and it breaks top-to-bottom text selection, which
  is load-bearing here (`primitives/select-scope`, `ContentScope`). It would fit
  the five log panels — all of which have a Copy button and never rely on
  selection — but two designs for one primitive is worse than one.
- **Inverting DOM ownership (a `<StickyScroll>` component)** — in 5 of 6 sites
  `JumpToBottomButton` is a *sibling* of the scroll box inside a `Pin`, next to
  a header row. Owning it means owning the surrounding layout, forcing compound
  components and a much larger migration for no additional guarantee. The
  returned-sentinel form gets the same deletion of `scrollIfPinned` for one line
  per site.
- **An inner content wrapper div** — provably harmless to sticky headers today
  (the sticky containing block is already the section `Stack`, and a bare div
  creates no stacking context or scrollport), but it is an unenforced invariant:
  anyone later adding `transform` / `contain` / `will-change` silently reparents
  the sticky headers. It buys nothing the sentinel does not already give.
  Note `overscroll-hint` (`overscroll-detector.ts:225-229`) applies
  `translateY` to every direct child of a scroll viewport during a rubber-band —
  another reason the sentinel should be a plain sibling.
- **`overflow-anchor` alone** — anchors above the viewport and deliberately
  suppresses bottom-follow (already reasoned in the 2026-05-25 doc, line 41).
- **`scroll-snap`** — `proximity` re-snaps on layout change, reintroducing the
  reflow-scroll bug; `mandatory` breaks free scrolling.

## Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts` | Rewrite: IO sentinel, foreign-scroll intent, `followKey`, opt-in `persist`, drop `resetKey`/`forceScrollKey`/`hasUnread`/`scrollIfPinned` |
| `plugins/primitives/plugins/auto-scroll/web/internal/sticky-scroll-machine.ts` *(new)* | Pure `reduce` + `sentinelObserverOptions` |
| `plugins/primitives/plugins/auto-scroll/web/internal/sticky-scroll-machine.test.ts` *(new)* | `bun:test` table-driven reducer tests |
| `plugins/primitives/plugins/auto-scroll/web/internal/bottom-sentinel.tsx` *(new)* | Sticky, 1px, zero-height sentinel |
| `plugins/primitives/plugins/auto-scroll/web/jump-to-bottom-button.tsx` | Drop `hasUnread` from `JumpToBottomView` |
| `plugins/primitives/plugins/auto-scroll/CLAUDE.md` | Document intent model + the sign-asymmetry argument vs. 2026-05-25 |
| `plugins/conversations/.../jsonl-viewer/core/event-key.ts` *(new)* | `eventKey(event)` |
| `plugins/conversations/.../jsonl-viewer/web/components/event-row.tsx` | Stamp `data-event-key`; keep `data-event-index` until the TOC migrates |
| `plugins/conversations/.../jsonl-viewer/web/components/jsonl-pane.tsx` | Render `{bottomSentinel}`, delete the `events.length` effect, `followKey={pendingTurns.length}`, enable `persist` |
| `plugins/conversations/.../jsonl-viewer/plugins/message-toc/web/components/message-toc.tsx` | Navigate by `data-event-key` (fixes the filtered-index bug) |
| `plugins/debug/plugins/logs/web/components/log-viewer.tsx` | Sentinel; `threshold: 32` → `rootMargin`; **add `JumpToBottomButton`** |
| `plugins/build/web/components/build-popover-content.tsx` | Sentinel; delete effect |
| `plugins/build/plugins/build-logs/web/components/build-log-section.tsx` | Sentinel; delete effect |
| `plugins/apps/plugins/deploy/plugins/deployments/web/components/deploy-log-panel.tsx` | Sentinel; delete effect |
| `plugins/apps/plugins/studio/.../release-logs/web/components/release-log-section.tsx` | Sentinel; delete effect |

Persistence stays **off by default** and is enabled only on `jsonl-pane`. In
particular `log-viewer` resets by remounting on `selectedKey` — enabling
persistence there would restore a stale anchor on every channel switch.

## Verification

1. `./equin build`, then use `http://<worktree>.localhost:9000`.
2. `bun test plugins/primitives/plugins/auto-scroll/web/internal/sticky-scroll-machine.test.ts`
3. **The reported bug.** Open a conversation containing code blocks (forces the
   shiki async path), scroll to the very bottom, refresh. Assert
   `scrollHeight - scrollTop - clientHeight <= threshold` after a settle window —
   not merely after network idle.
4. **Restore.** Scroll to the middle, note the visible message, refresh → same
   message. Navigate to another conversation and back → same message.
5. **No yank.** Sitting mid-transcript with an agent working, wait for new
   events: `scrollTop` must not change, and the jump-to-bottom button must
   appear.
6. **Follow.** At the bottom with an agent working, new events keep the view
   pinned to the bottom.
7. **The 2026-05-25 regression.** Scroll up partway, click a file-path link to
   open the file pane → the transcript must not scroll. Repeat at the bottom →
   it should stay at the bottom.
8. **The `revealElement` regression** (new in this design). At the bottom,
   expand a sticky user-message header → it must stay at the top of the pane,
   not snap back down.
9. **`message-toc`.** In a conversation containing an AskUserQuestion answer,
   click TOC entries and confirm each lands on the right message (this is
   broken today).
10. **Horizontal.** Scroll right past a wide code block while at the bottom →
    `following` must survive.
11. Write the flow as `plugins/conversations/.../jsonl-viewer/e2e/scroll-restore.ts`
    using the shared harness; `investigate-event/e2e/investigate-event.ts:42-54`
    is the model for waiting on transcript rows.
12. Guard: `rg '\.(scrollTop|scrollLeft)\s*=[^=]|\.(scrollTo|scrollBy)\('` must
    still match only `auto-scroll`'s allowlisted files.
13. `./equin check`.
