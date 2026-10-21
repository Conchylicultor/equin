import { useState, type ReactElement, type ReactNode } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Movable } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  CANVAS_CARD_ATTR,
  CANVAS_LAYOUT_ATTR,
  type CanvasLayout,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import {
  documentOptions,
  usePrototypeDetail,
  useStoredPicksOf,
} from "../context";
import {
  prototypeFrames,
  type CanvasFrame,
  type FrameId,
} from "../internal/canvas-model";
import {
  BOARD_PAD,
  FRAME_GAP,
  layoutFrames,
  roomPerFrame,
  type FrameLayout,
} from "../internal/layout";
import { useWindowSize } from "../internal/use-window-size";
import {
  pageHeightOf,
  sameExtent,
  type PageExtent,
} from "../internal/page-extent";
import { frameName, letterOf, type NamedFrame } from "../internal/frame-name";
import { CanvasFrameView } from "./canvas-frame-view";
import { FrameHeader, FRAME_HEADER_GAP } from "./frame-header";
import { OptionsPill } from "./options-pill";
import { SizeChip } from "./size-chip";
import { CanvasShortcuts } from "./canvas-shortcuts";
import { AddFrameRail } from "./add-frame-rail";
import { LayoutToggle } from "./layout-toggle";

/**
 * The canvas: every frame, side by side and centred (scrolling when they are
 * bigger than the pane), all at one size and zoom — or, with exactly two frames
 * and the Swipe layout, one swiped over the other. The size & zoom chip sits in
 * its bottom-right corner, and the add rail (`+`, Compare) on the last frame's
 * right edge, revealed by hovering it — the same chrome a presentation shows. The chip and every
 * options pill can be dragged off what they cover, anywhere in the canvas.
 */
export function Canvas({ meta }: { meta: PrototypeMeta }): ReactElement {
  const { canvas } = usePrototypeDetail();
  // The box the chrome is dragged around inside (`null` until it mounts).
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [roomRef, room] = useElementSize<HTMLDivElement>();
  const browserWindow = useWindowSize();
  // Each prototype frame's extent, for Whole page: the frames are fitted to
  // the tallest page.
  const [extents, setExtents] = useState<ReadonlyMap<FrameId, PageExtent>>(
    () => new Map(),
  );
  const reportExtent = (id: FrameId) => (extent: PageExtent) =>
    setExtents((prev) =>
      sameExtent(prev.get(id), extent) ? prev : new Map(prev).set(id, extent),
    );

  const swipe = canvas.layout === "swipe" && canvas.frames.length === 2;
  const per = roomPerFrame(
    { w: room.width, h: room.height },
    swipe ? 1 : canvas.frames.length,
  );
  const tallest = canvas.wholePage
    ? canvas.frames.reduce<number | null>((max, f) => {
        const e = extents.get(f.id);
        return e?.kind === "page" ? Math.max(max ?? 0, e.height) : max;
      }, null)
    : null;
  // Whole page is unavailable when no prototype frame on the canvas has a
  // page to show: every one sizes itself to its window.
  const protoFrames = prototypeFrames(canvas.frames);
  const noWholePage =
    canvas.wholePage &&
    protoFrames.length > 0 &&
    protoFrames.every((f) => extents.get(f.id)?.kind === "window-sized");
  const layout = layoutFrames({
    room: per,
    size: canvas.size,
    browserWindow,
    zoom: canvas.zoom,
    wholePage: canvas.wholePage,
    pageHeight: tallest,
  });
  const names = useFrameNames(meta);
  const measured = room.width > 0 && room.height > 0;
  // The layout drawn, not the one asked for: Swipe needs exactly two frames.
  const drawn: CanvasLayout = swipe ? "swipe" : "side";

  return (
    <div
      ref={setRoot}
      className="relative h-full bg-muted/40"
      {...{ [CANVAS_LAYOUT_ATTR]: drawn }}
    >
      <CanvasShortcuts />
      <Scroll ref={roomRef} axis="both" className="h-full">
        {measured ? (
          <Stack
            direction="row"
            gap="none"
            align="start"
            style={{
              gap: FRAME_GAP,
              padding: `${String(BOARD_PAD.top)}px ${String(BOARD_PAD.x)}px ${String(BOARD_PAD.bottom)}px`,
              minWidth: "max-content",
              minHeight: "100%",
            }}
          >
            {swipe ? (
              <SwipeFrames
                meta={meta}
                layout={layout}
                names={names}
                bounds={root}
              />
            ) : (
              canvas.frames.map((frame, index) => (
                <FrameCard
                  key={frame.id}
                  frame={frame}
                  index={index}
                  first={index === 0}
                  last={index === canvas.frames.length - 1}
                  swipeToggle={index === 1 && canvas.frames.length === 2}
                  meta={meta}
                  layout={layout}
                  name={names(frame)}
                  pageHeight={pageHeightOf(extents.get(frame.id))}
                  onPageExtent={reportExtent(frame.id)}
                  bounds={root}
                />
              ))
            )}
          </Stack>
        ) : null}
      </Scroll>
      <Movable at={{ pin: "bottom-right", offset: "md" }} bounds={root}>
          <SizeChip layout={layout} noWholePage={noWholePage} />
        </Movable>
    </div>
  );
}

/**
 * Every frame's name: a prototype frame by its variant (`frameName`), falling
 * back to the prototype's title when it declares no option; a source frame by
 * its source's add label ("Real app"). Exported for Present, whose tag names
 * the frame on show the way its header does.
 */
export function useFrameNames(
  meta: PrototypeMeta,
): (frame: CanvasFrame) => string {
  const { canvas, sources } = usePrototypeDetail();
  const picksOf = useStoredPicksOf();
  const named: NamedFrame[] = prototypeFrames(canvas.frames).map((f) => ({
    id: f.id,
    options: documentOptions(meta, f.version),
    picks: picksOf(f),
  }));
  return (frame) => {
    if (frame.kind === "source") {
      return (
        sources.find((s) => s.id === frame.source)?.addLabel ?? frame.source
      );
    }
    const target = named.find((n) => n.id === frame.id);
    const parts = target ? frameName(target, named) : [];
    return parts.length > 0 ? parts.join(" · ") : meta.title;
  };
}

/**
 * One frame on the board: header, screen and the options pill. Centred by auto margins (not `justify-content: center`), so
 * frames bigger than the canvas scroll instead of clipping.
 */
function FrameCard({
  frame,
  index,
  first,
  last,
  meta,
  layout,
  name,
  pageHeight,
  onPageExtent,
  bounds,
  swipeToggle,
}: {
  frame: CanvasFrame;
  index: number;
  first: boolean;
  last: boolean;
  /** The second of exactly two frames: the Swipe toggle sits in the gap before it. */
  swipeToggle: boolean;
  meta: PrototypeMeta;
  layout: FrameLayout;
  name: string;
  pageHeight: number | null;
  onPageExtent: (extent: PageExtent) => void;
  /** The canvas: what the options pill can be dragged around inside. */
  bounds: HTMLElement | null;
}): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const selected = canvas.selected === frame.id;
  const screenWidth = layout.width * layout.scale;

  return (
    <div
      className={cn("relative", hoverRevealGroup)}
      {...{ [CANVAS_CARD_ATTR]: letterOf(index) }}
      style={{
        width: screenWidth,
        marginBlock: "auto",
        marginLeft: first ? "auto" : undefined,
        marginRight: last ? "auto" : undefined,
      }}
    >
      <CanvasFrameView
        frame={frame}
        meta={meta}
        layout={layout}
        letter={letterOf(index)}
        wholePage={canvas.wholePage}
        pageHeight={pageHeight}
        onPageExtent={onPageExtent}
      >
        {(screen, resolution) => (
          <Stack gap="none" style={{ gap: FRAME_HEADER_GAP }}>
            <FrameHeader
              frame={frame}
              meta={meta}
              name={name}
              resolution={resolution}
            />
            <SelectableScreen
              selected={selected}
              onSelect={() => dispatch({ type: "select", id: frame.id })}
            >
              {screen}
              {frame.kind === "prototype" ? (
                // Sticks to the bottom of the view while its frame runs taller
                // than the canvas; revealed on hover. Zero height, inside the
                // screen's box, so it adds nothing to the frame's height.
                <Sticky edge="bottom" offset="md" className="h-0">
                  <div className="relative">
                    <Movable at={{ pin: screenWidth < 480 ? "bottom-left" : "bottom", offset: "md" }} bounds={bounds} className={hoverRevealTarget}>
                        <OptionsPill frame={frame} meta={meta} />
                      </Movable>
                  </div>
                </Sticky>
              ) : null}
            </SelectableScreen>
          </Stack>
        )}
      </CanvasFrameView>
      {last ? <EdgeRail meta={meta} /> : null}
      {swipeToggle ? (
        // Centred on the gap between the two frames, outside either screen so
        // pressing it never selects one.
        <Placed
          x={{ start: -FRAME_GAP / 2, shift: "-50%" }}
          y={{ center: "50%" }}
          layer="raised"
        >
          <LayoutToggle to="swipe" />
        </Placed>
      ) : null}
    </div>
  );
}

/**
 * The screen; clicking an unselected one selects it (what `[` `]` and `0` then
 * act on). Selection draws nothing — no ring, and its header's actions reveal
 * on hover like every other frame's — so the last-clicked frame never stands
 * out.
 */
function SelectableScreen({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cn("rounded-md", !selected && "cursor-pointer")}
      // A click inside a frame's iframe never reaches this document, but the
      // iframe taking focus does (focusin on the iframe element).
      onPointerDownCapture={selected ? undefined : onSelect}
      onFocusCapture={selected ? undefined : onSelect}
    >
      {children}
    </div>
  );
}

/**
 * The add rail on a frame's right edge, centred on its border line and
 * revealed by hovering the frame (the nearest hover-reveal group).
 */
function EdgeRail({ meta }: { meta: PrototypeMeta }): ReactElement {
  return (
    <Placed
      x={{ end: 0, shift: "50%" }}
      y={{ center: "50%" }}
      layer="raised"
      className={hoverRevealTarget}
    >
      <AddFrameRail meta={meta} />
    </Placed>
  );
}

/**
 * How far a swiped frame's options pill sits above the box's bottom edge, and
 * the divider's Side by side pill below its top edge, px.
 */
const SWIPE_PILL_INSET = 12;

/**
 * Swipe: the two frames in ONE box, B under A, A clipped at the divider — drag
 * the divider to wipe one design over the other. The divider carries the way
 * back to side by side at its top, and each prototype frame keeps its options pill,
 * bottom-centre of its own half.
 */
function SwipeFrames({
  meta,
  layout,
  names,
  bounds,
}: {
  meta: PrototypeMeta;
  layout: FrameLayout;
  names: (frame: CanvasFrame) => string;
  /** The canvas: what the options pills can be dragged around inside. */
  bounds: HTMLElement | null;
}): ReactElement | null {
  const { canvas, dispatch } = usePrototypeDetail();
  const [dragging, setDragging] = useState(false);
  const [a, b] = canvas.frames;
  if (a === undefined || b === undefined) return null;
  const width = layout.width * layout.scale;
  const height = layout.visibleHeight * layout.scale;
  const at = canvas.swipeAt;

  const moveTo = (clientX: number, box: HTMLElement) => {
    const rect = box.getBoundingClientRect();
    dispatch({ type: "setSwipeAt", at: (clientX - rect.left) / rect.width });
  };

  // Each frame renders ONCE: B's view wraps A's, so both screens and both
  // resolutions (a source frame's tag) are in hand for the one composition.
  return (
    <CanvasFrameView frame={b} meta={meta} layout={layout} letter={letterOf(1)}>
      {(screenB, resolutionB) => (
        <CanvasFrameView
          frame={a}
          meta={meta}
          layout={layout}
          letter={letterOf(0)}
        >
          {(screenA, resolutionA) => (
            <Stack
              gap="none"
              style={{
                gap: FRAME_HEADER_GAP,
                width,
                marginBlock: "auto",
                marginInline: "auto",
              }}
            >
              <Stack direction="row" gap="lg" align="center">
                <Fill>
                  <FrameHeader
                    frame={a}
                    meta={meta}
                    name={names(a)}
                    resolution={resolutionA}
                  />
                </Fill>
                <Text
                  variant="caption"
                  tone="faint"
                  className="whitespace-nowrap"
                >
                  ← drag →
                </Text>
                <Fill>
                  <FrameHeader
                    frame={b}
                    meta={meta}
                    name={names(b)}
                    resolution={resolutionB}
                  />
                </Fill>
              </Stack>
              <div
                className={cn("relative", hoverRevealGroup)}
                style={{ width, height }}
              >
                {screenB}
                <Placed
                  x="fill"
                  y="fill"
                  style={{
                    clipPath: `inset(0 ${String((1 - at) * 100)}% 0 0)`,
                  }}
                >
                  {screenA}
                </Placed>
                <Placed
                  x={{ start: `${String(at * 100)}%`, size: 2, shift: "-50%" }}
                  y="fill"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Drag to swipe between the two frames"
                  className={cn(
                    "cursor-ew-resize touch-none",
                    dragging ? "bg-primary" : "bg-foreground",
                  )}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDragging(true);
                  }}
                  onPointerMove={(e) => {
                    if (!dragging) return;
                    const box = e.currentTarget.parentElement;
                    if (box) moveTo(e.clientX, box);
                  }}
                  onPointerUp={() => setDragging(false)}
                  onPointerCancel={() => setDragging(false)}
                />
                <Placed
                  x={{ start: `${String(at * 100)}%`, shift: "-50%" }}
                  y={{ start: SWIPE_PILL_INSET }}
                  layer="raised"
                >
                  <LayoutToggle to="side" />
                </Placed>
                <EdgeRail meta={meta} />
                {[a, b].map((f, i) =>
                  f.kind === "prototype" ? (
                    // Bottom-centre of its own half: A's on the left, the
                    // side A shows on — clear of the size chip's corner.
                    <Movable
                      key={f.id}
                      at={{
                        x: { center: i === 0 ? "25%" : "75%" },
                        y: { end: SWIPE_PILL_INSET },
                        layer: "raised",
                      }}
                      bounds={bounds}
                      className={hoverRevealTarget}
                    >
                        <OptionsPill frame={f} meta={meta} />
                      </Movable>
                  ) : null,
                )}
              </div>
            </Stack>
          )}
        </CanvasFrameView>
      )}
    </CanvasFrameView>
  );
}
