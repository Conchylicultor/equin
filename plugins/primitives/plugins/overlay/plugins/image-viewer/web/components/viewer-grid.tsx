import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { keepInPlace } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import {
  useRevealOnActive,
  focusElement,
} from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { thumbnailShape, type Area } from "../../core";
import { knownSize, pixelRatio } from "../internal/pick-src";
import type { ViewerImage } from "../internal/types";
import type { ViewController } from "../internal/view-controller";
import { ViewStore } from "../internal/view-store";
import { ThumbImg } from "./thumb-img";

/** Below this aspect (height ÷ width) a tile shows the whole image; above it
 *  — a full-page screenshot — the top of it, like the transcript thumbnail. */
const TALL_RATIO = 1.6;

/** Room kept under the last row so the floating toolbar never covers it. */
const TOOLBAR_CLEARANCE = 24;

/** A tile may stretch past the slider's width to fill its row (`1fr`), so its
 *  copy is asked for with this much room. */
const TILE_STRETCH = 1.5;

/**
 * The copy size tiles ask for at tile width `tile`: rounded UP to a power of
 * two, so dragging the slider changes it (and re-renders the tiles) only when
 * the size doubles — not on every tick.
 */
function tileEdge(tile: number): number {
  return 2 ** Math.ceil(Math.log2(tile * TILE_STRETCH * pixelRatio()));
}

/** A ⌘-scroll or pinch's tile anchor stays this long after its last event. */
const POINTER_ANCHOR_MS = 300;

// Memoized with an index-keyed callback pair, so a resize — which only moves
// the grid's `--tile` — re-renders no tile, and a selection move re-renders two.
const GridTile = memo(function GridTile({
  image,
  index,
  current,
  edge,
  onSelect,
  onOpen,
}: {
  image: ViewerImage;
  index: number;
  current: boolean;
  edge: number;
  onSelect(index: number): void;
  onOpen(index: number): void;
}) {
  const reveal = useRevealOnActive(current, {
    revealOnMount: true,
    block: "nearest",
  });
  const known = knownSize(image);
  const tiny = known !== null && thumbnailShape(known) === "tiny";
  const tall = known !== null && known.height > known.width * TALL_RATIO;
  return (
    <button
      ref={reveal}
      type="button"
      data-grid-tile={index}
      // One tab stop: the selected tile. The arrow keys move between tiles.
      tabIndex={current ? 0 : -1}
      aria-label={image.name}
      aria-current={current}
      onFocus={() => onSelect(index)}
      onClick={() => onOpen(index)}
      // Off-screen tiles skip layout and paint; the intrinsic size keeps the
      // scrollbar honest meanwhile.
      className="group/tile @container block w-full text-left [contain-intrinsic-size:auto_var(--tile)] [content-visibility:auto] focus-visible:outline-none"
    >
      <Stack gap="xs">
        <Clip
          className={cn(
            "relative aspect-[4/3] w-full rounded-md bg-foreground/5 ring-offset-2 ring-offset-background transition-[background-color,box-shadow] group-hover/tile:bg-foreground/10",
            current && "ring-2 ring-primary",
            "group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-primary",
          )}
        >
          <ThumbImg
            image={image}
            edge={edge}
            className={cn(
              "pointer-events-none block size-full",
              tiny
                ? "object-none [image-rendering:pixelated]"
                : tall
                  ? "object-cover object-top"
                  : "object-contain",
            )}
          />
        </Clip>
        {/* Captions from TILE_CAPTION_MIN (140px) of the tile's own width — a
            container query, so a resize never re-renders a tile to decide it. */}
        <Line className="gap-sm px-2xs @max-[139px]:hidden">
          <Fill>
            <Text variant="code">{image.name}</Text>
          </Fill>
          {known && (
            <Text variant="caption" tone="muted" className="tabular-nums">
              {known.width} × {known.height}
            </Text>
          )}
        </Line>
      </Stack>
    </button>
  );
});

/**
 * Every image as tiles on a solid ground, below the top bar and above the
 * toolbar. The store's `tile` is the slider's minimum tile width — the browser
 * packs as many columns as fit. A resize is written straight onto the grid as
 * `--tile`, never through React, and keeps the tile under the pointer (or the
 * selected one) where it was on screen. ⌘-scroll or a pinch on the grid
 * resizes the tiles, at most once a frame; a plain scroll scrolls it.
 * Selection is the viewer's own index: focusing a tile selects it, clicking
 * one (or Enter) opens it.
 */
export function ImageGrid({
  images,
  index,
  area,
  gridRef,
  ctl,
  onSelect,
  onOpen,
}: {
  images: readonly ViewerImage[];
  index: number;
  area: Area | null;
  /** The tile grid itself — the viewer reads its column count for ↑ / ↓. */
  gridRef: RefObject<HTMLElement | null>;
  ctl: ViewController;
  onSelect(index: number): void;
  onOpen(index: number): void;
}) {
  const store = ViewStore.useStoreApi();
  const scrollRef = useRef<HTMLElement>(null);
  const [initialTile] = useState(() => store.getState().tile);
  // Only ever grows while the grid is open: a smaller tile can draw the
  // larger copy it already has, without fetching anything.
  const [edge, setEdge] = useState(() => tileEdge(initialTile));

  // The tile the next resize keeps in place: the one under a ⌘-scroll or
  // pinch, for a moment after it; otherwise the selected one.
  const pointerAnchor = useRef<{ el: Element; at: number } | null>(null);
  const anchor = useEventCallback((): Element | null => {
    const p = pointerAnchor.current;
    if (p && performance.now() - p.at < POINTER_ANCHOR_MS && p.el.isConnected)
      return p.el;
    return (
      gridRef.current?.querySelector(`[data-grid-tile="${index}"]`) ?? null
    );
  });

  // The resize writer.
  useLayoutEffect(() => {
    let last = store.getState().tile;
    return store.subscribe(() => {
      const { tile } = store.getState();
      if (tile === last) return;
      last = tile;
      const grid = gridRef.current;
      const scroller = scrollRef.current;
      if (!grid || !scroller) return;
      keepInPlace(scroller, anchor(), () =>
        grid.style.setProperty("--tile", `${tile}px`),
      );
      setEdge((e) => Math.max(e, tileEdge(tile)));
    });
  }, [store, gridRef, anchor]);

  // Registered non-passive so a ⌘-scroll or pinch resizes the tiles instead
  // of zooming the page; a plain scroll is left to scroll the grid. Events
  // arrive faster than frames: their factors are multiplied together and
  // applied once per frame.
  const pending = useRef<{ factor: number; frame: number } | null>(null);
  const resize = useEventCallback((e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const tile =
      e.target instanceof Element ? e.target.closest("[data-grid-tile]") : null;
    if (tile) pointerAnchor.current = { el: tile, at: performance.now() };
    const factor = Math.exp(-e.deltaY * 0.01);
    if (pending.current) {
      pending.current.factor *= factor;
      return;
    }
    pending.current = {
      factor,
      frame: requestAnimationFrame(() => {
        const p = pending.current;
        pending.current = null;
        if (p) ctl.setTile(store.getState().tile * p.factor);
      }),
    };
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("wheel", resize, { passive: false });
    return () => {
      el.removeEventListener("wheel", resize);
      if (pending.current) cancelAnimationFrame(pending.current.frame);
      pending.current = null;
    };
  }, [resize]);

  // Keyboard focus follows the selection: once a tile has focus, an arrow key
  // that moves the selection moves focus with it, so Enter opens what is ringed.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const active = document.activeElement;
    if (!grid || !(active instanceof HTMLElement) || !grid.contains(active))
      return;
    focusElement(
      grid.querySelector<HTMLElement>(`[data-grid-tile="${index}"]`),
      {
        reveal: false,
      },
    );
  }, [gridRef, index]);

  const select = useEventCallback(onSelect);
  const open = useEventCallback(onOpen);
  return (
    <Layer>
      <Layer decorative className="bg-background" />
      <Scroll
        ref={scrollRef}
        axis="y"
        className="relative size-full px-xl"
        style={{
          paddingTop: area?.top,
          paddingBottom: (area?.bottom ?? 0) + TOOLBAR_CLEARANCE,
        }}
      >
        <Grid
          ref={gridRef}
          minCellWidth="min(var(--tile), 100%)"
          gap="md"
          aria-label="All images"
          role="group"
          // The starting size; every later one is written by the resize writer.
          style={{ "--tile": `${initialTile}px` } as CSSProperties}
        >
          {images.map((image, i) => (
            <GridTile
              key={`${i}:${image.src}`}
              image={image}
              index={i}
              current={i === index}
              edge={edge}
              onSelect={select}
              onOpen={open}
            />
          ))}
        </Grid>
      </Scroll>
    </Layer>
  );
}
