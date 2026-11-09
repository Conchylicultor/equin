import {
  Sticky,
  stickyOffsetPx,
  type StickyProps,
} from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

/**
 * Above this many items the stack degrades to the swap hand-off (every item pins
 * at `base`, so each new one covers the last). Rationale: a pinned item costs its
 * own height of viewport **permanently** — stack 20 group headers and the content
 * they head is squeezed off-screen. Below the cap the stack is a navigational aid
 * (you can see every group you scrolled past); above it, it is a viewport tax.
 */
export const DEFAULT_MAX_STACKED = 5;

interface StickyStackCtx {
  keys: readonly string[];
  base: string;
  stacked: boolean;
  /** Measured item heights (snapped by `stickyOffsetPx`), keyed by item key. Missing ⇒ not measured yet. */
  heights: ReadonlyMap<string, number>;
  /** `null` height removes the entry (unmount). Stable identity. */
  reportHeight: (key: string, height: number | null) => void;
}

const StickyStackContext = createContext<StickyStackCtx | null>(null);

/** The keys of the {@link StickyStackBranch}es enclosing a point, outermost
 *  first — an item's ancestor chain. */
const BranchChainContext = createContext<readonly string[]>([]);

function useCtx(): StickyStackCtx {
  const ctx = useContext(StickyStackContext);
  if (!ctx)
    throw new Error("<StickyStackItem> must be used inside a <StickyStack>");
  return ctx;
}

/**
 * Pure `top` resolution for one stack item — exported so the component and the
 * test share one definition of the offset math.
 *
 * Not stacked → everything pins at `base` (the swap hand-off: each arriving item
 * covers the pinned one). Stacked → the item pins below every item preceding it
 * in `keys`, i.e. `base + Σ(heights of the earlier keys)`. An unmeasured earlier
 * key contributes 0; element-size measures synchronously in a layout effect, so
 * that gap closes before paint rather than as a visible jump.
 *
 * Not stacked but nested (`ancestors`, the keys of the enclosing branches) →
 * the item pins below its ancestor chain only, `base + Σ(ancestor heights)`:
 * siblings still swap, while the parents they belong to stay pinned above them.
 *
 * An `itemKey` absent from `keys` is a wiring bug (the provider's key list and
 * its children disagree), never a transient state — so it throws rather than
 * silently pinning at the wrong offset.
 */
export function stickyStackTop(opts: {
  keys: readonly string[];
  heights: ReadonlyMap<string, number>;
  itemKey: string;
  base: string;
  stacked: boolean;
  /** The item's enclosing branch keys, outermost first. Default: none. */
  ancestors?: readonly string[];
}): string {
  const index = opts.keys.indexOf(opts.itemKey);
  if (index < 0)
    throw new Error(
      `<StickyStackItem itemKey="${opts.itemKey}"> is not present in its <StickyStack keys={…}> (${opts.keys.join(", ")})`,
    );
  const above = opts.stacked
    ? opts.keys.slice(0, index)
    : (opts.ancestors ?? []);
  if (above.length === 0) return opts.base;
  let sum = 0;
  for (const key of above) sum += opts.heights.get(key) ?? 0;
  return `calc(${opts.base} + ${sum}px)`;
}

export interface StickyStackProps {
  /** Ordered keys of the stack's items, top→bottom in DOM order. Its length
   *  decides whether the stack stacks. */
  keys: string[];
  /** CSS length the first item pins at (e.g. `var(--dv-header-offset, 0px)` or a
   *  `calc(...)`). Defaults to `"0px"`. */
  base?: string;
  /** Stack only while `keys.length <= maxStacked`; above it every item pins at
   *  `base` (the swap hand-off). Defaults to {@link DEFAULT_MAX_STACKED}. */
  maxStacked?: number;
  children: ReactNode;
}

/**
 * The "N sticky siblings sharing one containing block, each pinned below the ones
 * before it" idiom — sticky section headers that accumulate at the top instead of
 * swapping.
 *
 * **It renders no DOM element**, only a context provider. That is load-bearing:
 * `position: sticky` is bounded by the item's nearest scrollable-ancestor-relative
 * containing block, so wrapping the items in a div would re-bound each item to the
 * wrapper and un-pin it the moment the wrapper scrolls away — precisely the
 * behaviour a stack must not have. The items must stay direct children of the
 * caller's own real containing block (the list `<Stack>`, the subgrid table).
 *
 * The stack is capped ({@link DEFAULT_MAX_STACKED}) because every pinned item
 * permanently eats viewport height; past the cap it degrades to the classic swap
 * hand-off.
 */
export function StickyStack({
  keys,
  base = "0px",
  maxStacked = DEFAULT_MAX_STACKED,
  children,
}: StickyStackProps): ReactNode {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  // Write only when the snapped value actually moved: each item reports from a
  // layout effect fed by a ResizeObserver, so an unconditional setState here
  // would be an observe→render→observe loop.
  const reportHeight = useCallback((key: string, height: number | null) => {
    setHeights((prev) => {
      if (height === null) {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      }
      if (prev.get(key) === height) return prev;
      return new Map(prev).set(key, height);
    });
  }, []);

  const stacked = keys.length <= maxStacked;
  const value = useMemo(
    () => ({ keys, base, stacked, heights, reportHeight }),
    [keys, base, stacked, heights, reportHeight],
  );

  return <StickyStackContext value={value}>{children}</StickyStackContext>;
}

export interface StickyStackItemProps extends Omit<
  StickyProps,
  "edge" | "offset"
> {
  /** This item's key; must be present in the provider's `keys`. */
  itemKey: string;
}

/**
 * One member of a {@link StickyStack} — a `<Sticky edge="top">` whose `top` the
 * stack computes, and which measures its own height so the items after it know
 * where to pin. Every other `Sticky` prop (`mask`, `layer`, `as`, `className`, …)
 * passes straight through; only the stack-owned `top` is ours (it wins over a
 * caller `style.top`, which would otherwise silently break the stack).
 */
export function StickyStackItem({
  itemKey,
  ref,
  style,
  children,
  ...rest
}: StickyStackItemProps): ReactNode {
  const { keys, base, stacked, heights, reportHeight } = useCtx();
  const chain = useContext(BranchChainContext);
  // The item heads its own branch (when it has one): that key is not its
  // ancestor.
  const ancestors = chain.at(-1) === itemKey ? chain.slice(0, -1) : chain;
  const [measureRef, { height }] = useElementSize();

  // The item is both the stack's measurement target and (possibly) a caller's ref
  // target, and a DOM node takes one `ref` — so the two compose.
  const composedRef = useCallback(
    (el: HTMLElement | null) => {
      measureRef(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [measureRef, ref],
  );

  // Snap once, here, to the layout unit — never to whole pixels: the next item
  // pins at exactly this height, so a rounded 29.5 → 30 left a half-pixel strip
  // between the bands where the rows behind showed through.
  const rounded = stickyOffsetPx(height);
  // Layout effect, not a plain effect: the corrected offsets must land in the same
  // frame as the measure, so the stack never paints at a stale `top`.
  useLayoutEffect(() => {
    reportHeight(itemKey, rounded);
  }, [itemKey, rounded, reportHeight]);
  // Separate effect so a height change doesn't delete-then-re-add the entry (which
  // would flash every later item up to a missing-height offset).
  useLayoutEffect(() => {
    return () => reportHeight(itemKey, null);
  }, [itemKey, reportHeight]);

  const top = stickyStackTop({
    keys,
    heights,
    itemKey,
    base,
    stacked,
    ancestors,
  });

  return (
    <Sticky ref={composedRef} edge="top" {...rest} style={{ ...style, top }}>
      {children}
    </Sticky>
  );
}

export interface StickyStackBranchProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  /** The key of the item heading this branch; must be present in the
   *  provider's `keys`. */
  itemKey: string;
  /** The heading item, its content, and the branches nested under it. */
  children: ReactNode;
}

/**
 * One item's subtree — its heading `StickyStackItem`, what it heads, and the
 * branches nested below it — for a stack whose items form a tree (nested
 * section headers). Past the cap it keeps the **parent chain** pinned: an item
 * pins below its ancestors' items, so you always see which parent the pinned
 * header belongs to, while siblings at each level still swap.
 *
 * Stacked, it renders no DOM (every item already stays pinned, all sharing the
 * caller's one containing block). Past the cap it renders a plain block box,
 * and that box is load-bearing: it is the subtree's sticky containing block, so
 * once the branch scrolls away its items leave with it — without it a finished
 * branch's child header would stay pinned under the next parent. A plain
 * block box lays its children out like the caller's gapless column, so the
 * switch does not move anything; a caller laying its items out otherwise (the
 * subgrid table: `col-span-full grid grid-cols-subgrid`) passes the box's
 * `className`, and any other attribute (a `role`), which apply to that box only.
 */
export function StickyStackBranch({
  itemKey,
  children,
  ...box
}: StickyStackBranchProps): ReactNode {
  const { keys, stacked } = useCtx();
  if (!keys.includes(itemKey))
    throw new Error(
      `<StickyStackBranch itemKey="${itemKey}"> is not present in its <StickyStack keys={…}> (${keys.join(", ")})`,
    );
  const parent = useContext(BranchChainContext);
  const chain = useMemo(() => [...parent, itemKey], [parent, itemKey]);
  return (
    <BranchChainContext value={chain}>
      {stacked ? children : <div {...box}>{children}</div>}
    </BranchChainContext>
  );
}
