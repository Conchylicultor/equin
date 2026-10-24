# One sanctioned home for `IntersectionObserver`

## Context

`ResizeObserver` has exactly one implementation in the repo — `useResizeObserver`
in [`primitives/element-size`](../plugins/primitives/plugins/element-size/) — and a
lint rule (`no-raw-resize-observer`) whose allowlist names that single file.
`IntersectionObserver` has no such home. It is hand-rolled in **four** places:

| site | question it answers | band | picks |
| --- | --- | --- | --- |
| `transcript-stats/web/use-reading-anchor.ts` | how far has the reader got? | whole viewport | **last** row on screen |
| `outline/scroll-spy/web/internal/use-active-in-view.ts` | which section is the reader looking at? | top third | **first** id on screen |
| `cursor-pagination/web/internal/use-infinite-scroll.ts` | has the sentinel arrived? | caller `rootMargin` | one element, boolean |
| `auto-scroll/web/use-sticky-scroll.ts` | is the bottom still visible? | pin distance + huge x-slack | one element, boolean |

The first two are the same question with two knobs turned differently, and the
second was written by **copying** the first — because the first had already
learned two non-obvious rules the hard way: hold the last answer when nothing is
on screen, and enroll elements incrementally through a `WeakSet`. Copying is the
only thing keeping those rules alive, so the next site can silently omit one.
Neither omission fails loudly; both produce a highlight that flickers or lags.

The two copies have already diverged: `useActiveInView` additionally learned that
"resolved nothing yet" is not terminal (a host reports its sections before the
surface renders them) and grew a self-disarming `MutationObserver` for it.
`useReadingAnchor` neither has nor needs that, because it reads a DOM attribute
rather than opaque caller ids.

Separately, `use-reading-anchor.ts` carries the last surviving copy of the
`paneScrollFrom` DOM walk. `jsonl-viewer` publishes its scroll element through
`usePaneScrollElement()`, and `outline` already retired its own copy of that walk
in favour of it — this one was simply missed.

**Outcome:** one plugin owns `new IntersectionObserver`, a lint rule with a
one-entry allowlist keeps it that way, and the "which element is the reader on"
question has exactly one implementation instead of two divergent ones.

## The design

Three layers, mirroring `element-size`'s substrate/ergonomic split.

```
createInViewWatcher(onChange, opts)   ← DOM layer. The repo's only `new IntersectionObserver`.
        │                                Owns the WeakSet enrollment rule.
  useInView(target, onChange, opts)   ← React layer. Lifecycle + deps-keyed rebuild.
        │
  useActiveInView(ids, resolve, opts) ← Domain layer (scroll-spy). Owns hold-last-value,
                                         root derivation, the MutationObserver gap-fill,
                                         and the two named reading positions.
```

### 1. New plugin `plugins/primitives/plugins/in-view/`

Files, mirroring `element-size` exactly: `package.json`, `CLAUDE.md`,
`web/index.ts` (barrel: named re-exports + `export default { description,
contributions: [] } satisfies PluginDefinition`), `web/internal/in-view.ts` (the
implementation, and the lint allowlist's one entry).

```ts
export type InViewTarget = RefLike | (() => Element | null | undefined);
export type InViewRoot = RefLike | Element | null;
export type InViewOptions = { root?: InViewRoot; rootMargin?: string; threshold?: number | number[] };

export interface InViewWatcher {
  /** Idempotent: a node already watched is skipped, so a re-enrollment pass costs nothing. */
  observe(el: Element): void;
  disconnect(): void;
}

/** The DOM layer. The one `new IntersectionObserver`. */
export function createInViewWatcher(
  onChange: (entries: IntersectionObserverEntry[]) => void,
  options?: InViewOptions,
): InViewWatcher;

/** The React layer: observe one target, run `onChange` per delivery. */
export function useInView(
  target: InViewTarget,
  onChange: (entry: IntersectionObserverEntry) => void,
  options?: InViewOptions & { deps?: DependencyList },
): void;
```

Deliberately **no** `useIsInView(): boolean` convenience. Both single-element
consumers write to a ref rather than to state precisely so a scroll costs no
render; a boolean form would have no caller and would invite one to be added.

**`deps` is load-bearing, not ergonomics.** `useInView` stabilises `onChange`
internally (`useEventCallback`), so without `deps` the observer is built once and
never rebuilt — and a *rebuild* is how `use-infinite-scroll` fires page N+1: the
fresh observer re-delivers against the still-intersecting sentinel. Stabilise the
callback and drop the rebuild and pagination silently stalls after page 1. This
must be stated in the primitive's `CLAUDE.md`, not just in a code comment.

### 2. `useActiveInView` absorbs `useReadingAnchor`

`plugins/primitives/plugins/outline/plugins/scroll-spy/web/internal/use-active-in-view.ts`
gains one option pairing the band and the pick, because the two are one decision:

```ts
export type ReadingPosition = "reading-line" | "furthest-read";

const POSITIONS = {
  // Notion-style: the section you are reading is the first one in the top third.
  "reading-line":  { rootMargin: "0px 0px -66% 0px", pick: "first" },
  // A read watermark: the furthest row you have reached, anywhere on screen.
  "furthest-read": { rootMargin: undefined,          pick: "last"  },
} as const;

export function useActiveInView(
  ids: string[],
  resolve: (id: string) => Element | null,
  options?: { position?: ReadingPosition },   // default "reading-line"
): string | null;
```

Changes inside the hook:

- `new IntersectionObserver(...)` → `createInViewWatcher(...)`; `enrolledRef`
  (the `WeakSet`) is deleted — it now lives in the watcher.
- the reducer scans `idsRef.current` in order and takes the first or the last id
  present in `onScreen`, per `pick`. Everything else — hold-last-value, the
  `known`-set prune, lazy construction so `findScrollParent` has an element, the
  self-disarming `MutationObserver` — is unchanged.
- `idOfRef` (the element→id `WeakMap`) stays: that is the id contract, not the
  observer.

### 3. `transcript-stats` becomes a caller

Delete `web/use-reading-anchor.ts` entirely — with it, the `paneScrollFrom` walk
and the `rowCount` staleness hack. In
`web/components/transcript-stats-strip.tsx`, `StripWithEvents` drops `hostRef`
(its only purpose was scroller discovery) and reads:

```ts
const scroller = usePaneScrollElement();
const ids = useMemo(() => visible.map((_, i) => String(i)), [visible]);
const resolve = useCallback(
  (id: string) => scroller?.querySelector(`[data-event-index="${CSS.escape(id)}"]`) ?? null,
  [scroller],
);
const anchorId = useActiveInView(ids, resolve, { position: "furthest-read" });
const anchor = anchorId === null ? null : Number(anchorId);
```

The `rowCount` limit filter is gone for free: today a torn-out row's index can
outlive it inside the observer's `onScreen` set and pin the anchor past the last
real row, which is why the guard existed. Driving the pick from `ids` — which
come from the caller's current `visible` array — means a dropped row simply is
not a candidate.

Neither import is a new plugin edge to invent: `transcript-stats` already imports
`@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web` (for
`useVisibleEvents`), and `scroll-spy` is a leaf primitive, so
`@plugins/primitives/plugins/outline/plugins/scroll-spy/web` adds no cycle.

### 4. The two sentinel sites route through `useInView`

Both keep their own policy; only the observer construction moves.

- `cursor-pagination/web/internal/use-infinite-scroll.ts` — the error gate
  (`!isFetchNextPageError`) stays exactly as written. Pass
  `deps: [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, rootMargin]`,
  i.e. today's effect dep array, so the rebuild-on-gate-change behaviour the
  pattern depends on is byte-for-byte preserved.
- `auto-scroll/web/use-sticky-scroll.ts` — `root` is the scroll container, passed
  as `scrollRef` (this is why `InViewRoot` accepts a ref); options still come
  from `sentinelObserverOptions(threshold)` in `internal/sticky-scroll-machine.ts`,
  which is untouched. `deps: [sentinelEl, threshold, writeToBottom]`. The callback
  still writes `sentinelVisibleRef` and consults `followAction` — no re-render,
  no change to the async-delivery reasoning documented there.

### 5. The lint rule

New sibling under the lint umbrella, mirroring `resize-observer-safety`
byte-for-byte: `plugins/framework/plugins/tooling/plugins/lint/plugins/intersection-observer-safety/`
with `package.json`, `CLAUDE.md`, `lint/no-raw-intersection-observer.ts` (a plain
`NewExpression` check on the `IntersectionObserver` identifier) and `lint/index.ts`:

```ts
ignores: {
  // The in-view primitive is the one sanctioned home for the idiom.
  "no-raw-intersection-observer": [
    "plugins/primitives/plugins/in-view/web/internal/in-view.ts",
  ],
},
```

**One entry, no exceptions.** The known non-sites stay clean on their own: the
bun-runtime stub (`plugin-meta/barrel-import/core/internal/stubs.ts:77`) and the
jsdom test doubles *assign* a class to `globalThis`, they never write
`new IntersectionObserver`, so the rule does not fire on them.

Add a `RuleTester` test (`lint/no-raw-intersection-observer.test.ts`) following
the `scroll-safety/lint/no-adhoc-scroll-write.test.ts` precedent —
`resize-observer-safety` has none, and that gap is not worth mirroring.

## Files

| file | change |
| --- | --- |
| `plugins/primitives/plugins/in-view/**` | new plugin (4 files) |
| `plugins/framework/plugins/tooling/plugins/lint/plugins/intersection-observer-safety/**` | new lint plugin (5 files incl. test) |
| `plugins/primitives/plugins/outline/plugins/scroll-spy/web/internal/use-active-in-view.ts` | `position` option; observer → watcher |
| `plugins/primitives/plugins/outline/plugins/scroll-spy/CLAUDE.md` | document `position`; delete the now-stale "The third hand-rolled site" section |
| `plugins/conversations/.../transcript-stats/web/use-reading-anchor.ts` | **deleted** |
| `plugins/conversations/.../transcript-stats/web/components/transcript-stats-strip.tsx` | calls `useActiveInView` |
| `plugins/primitives/plugins/cursor-pagination/web/internal/use-infinite-scroll.ts` | → `useInView` |
| `plugins/primitives/plugins/auto-scroll/web/use-sticky-scroll.ts` | → `useInView` |
| `cursor-pagination/CLAUDE.md`, `auto-scroll/CLAUDE.md` | point their "don't hand-roll" notes at the lint rule |

## Verification

1. `./equin check` — `eslint` (the new rule runs repo-wide and must find
   zero violations outside the allowlist), `type-check`, `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries`.
2. `./equin test plugins/primitives/plugins/cursor-pagination` — the
   existing `use-infinite-scroll.test.tsx` drives a `FakeIntersectionObserver`
   through `vi.stubGlobal` and must pass **unchanged**; that is the regression
   test for the `deps` hazard above. Then `./equin test` for the rest, and
   check whether `test/setup.ts` needs an inert global `IntersectionObserver`
   alongside its inert `ResizeObserver` now that jsdom-mounted surfaces reach the
   primitive.
3. `./equin build` (background), then in
   `http://<worktree>.localhost:9000`:
   - **conversation** — open a long transcript, scroll up: the stats strip must
     walk its numbers back and show the history chip, and scrolling to the end
     must restore the totals. The transcript outline rail's current dash must
     track the turn you are on.
   - **Pages** — open a page with several headings; the outline rail's bright
     dash must follow as you scroll (this is the consumer that needed the
     `MutationObserver` gap-fill, so it is the one that proves it survived).
   - **any DataView list** (e.g. All conversations) — scroll to the bottom
     repeatedly: pages 2, 3, 4… must keep loading. One page then a stall is the
     `deps` hazard.
   - **stick-to-bottom** — with a live agent running, sit at the bottom and
     confirm new rows keep the view pinned; scroll up and confirm it stays parked.
