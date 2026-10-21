import { useState, type ReactElement, type ReactNode } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
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
  FRAME_HEAD_GAP,
  layoutFrames,
  placeFrames,
  roomPerFrame,
  type FrameBox,
  type FrameLayout,
} from "../internal/layout";
import { GEOMETRY_MOTION } from "../internal/geometry-motion";
import { useWindowSize } from "../internal/use-window-size";
import {
  pageHeightOf,
  sameExtent,
  type PageExtent,
} from "../internal/page-extent";
import { frameName, letterOf, type NamedFrame } from "../internal/frame-name";
import { CanvasFrameView } from "./canvas-frame-view";
import { FrameHeader } from "./frame-header";
import { SizeDock } from "./size-chip";
import { CanvasShortcuts } from "./canvas-shortcuts";
import { AddFrameRail } from "./add-frame-rail";
import { LayoutToggle } from "./layout-toggle";

/**
 * The ground the frames sit on: a 28px grid of hairlines in the foreground ink
 * at 3.6%, under a vignette that darkens to the background at the edges — the
 * viewer mock's `.canvas`. It does not scroll: the frames move over it.
 */
const CANVAS_GROUND =
  "bg-background bg-[image:radial-gradient(ellipse_90%_85%_at_50%_50%,transparent_55%,var(--background)_100%),linear-gradient(color-mix(in_oklab,var(--foreground)_3.6%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--foreground)_3.6%,transparent)_1px,transparent_1px)] bg-[size:100%_100%,28px_28px,28px_28px] bg-[position:0_0,-1px_-1px,-1px_-1px]";

/**
 * The canvas: every frame side by side, each centred in its share of the room
 * the floating chrome leaves (scrolling when they are bigger than it), all at
 * one size and zoom — or, with exactly two frames and the Swipe layout, one
 * swiped over the other. Frames are placed by runtime numbers (`placeFrames`),
 * so a layout change glides each one to its new box (`GEOMETRY_MOTION`). The
 * size & zoom chip floats over the bottom, the add rail (`+`, Compare) sits on
 * the last frame's right edge, revealed by hovering it — the same chrome a
 * presentation shows.
 */
export function Canvas({ meta }: { meta: PrototypeMeta }): ReactElement {
  const { canvas } = usePrototypeDetail();
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
  const slots = swipe ? 1 : canvas.frames.length;
  const viewport = { w: room.width, h: room.height };
  const per = roomPerFrame(viewport, slots);
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
  const { boxes, extent } = placeFrames(viewport, slots, {
    w: layout.width * layout.scale,
    h: layout.visibleHeight * layout.scale,
  });
  const names = useFrameNames(meta);
  const measured = room.width > 0 && room.height > 0;
  // The layout drawn, not the one asked for: Swipe needs exactly two frames.
  const drawn: CanvasLayout = swipe ? "swipe" : "side";
  const [first, second] = boxes;

  return (
    <div
      className={cn("relative h-full", CANVAS_GROUND)}
      {...{ [CANVAS_LAYOUT_ATTR]: drawn }}
    >
      <CanvasShortcuts />
      <Scroll ref={roomRef} axis="both" className="h-full">
        {measured ? (
          // The board: as big as the frames need, at least the viewport.
          <div
            className="relative"
            style={{ width: extent.w, height: extent.h }}
          >
            {swipe && first ? (
              <SwipeFrames
                meta={meta}
                layout={layout}
                names={names}
                box={first}
              />
            ) : (
              canvas.frames.map((frame, index) => {
                const box = boxes[index];
                return box ? (
                  <FrameCard
                    key={frame.id}
                    frame={frame}
                    index={index}
                    last={index === canvas.frames.length - 1}
                    meta={meta}
                    layout={layout}
                    box={box}
                    name={names(frame)}
                    pageHeight={pageHeightOf(extents.get(frame.id))}
                    onPageExtent={reportExtent(frame.id)}
                  />
                ) : null;
              })
            )}
            {!swipe && canvas.frames.length === 2 && first && second ? (
              // Centred on the gap between the two frames, outside either
              // screen so pressing it never selects one.
              <Placed
                x={{ center: (first.x + first.w + second.x) / 2 }}
                y={{ center: second.y + second.h / 2 }}
                layer="raised"
                className={GEOMETRY_MOTION}
              >
                <LayoutToggle to="swipe" />
              </Placed>
            ) : null}
          </div>
        ) : null}
      </Scroll>
      <SizeDock layout={layout} noWholePage={noWholePage} />
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
 * One frame on the board, at its box: the screen fills it, the header sits
 * `FRAME_HEAD_GAP` above it, and the box is the hover-reveal anchor of both
 * (the header's actions, the add rail on the last frame).
 */
function FrameCard({
  frame,
  index,
  last,
  meta,
  layout,
  box,
  name,
  pageHeight,
  onPageExtent,
}: {
  frame: CanvasFrame;
  index: number;
  last: boolean;
  meta: PrototypeMeta;
  layout: FrameLayout;
  /** Where the screen sits on the board (`placeFrames`). */
  box: FrameBox;
  name: string;
  pageHeight: number | null;
  onPageExtent: (extent: PageExtent) => void;
}): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const selected = canvas.selected === frame.id;

  return (
    <Placed
      x={{ start: box.x, size: box.w }}
      y={{ start: box.y, size: box.h }}
      className={cn(hoverRevealGroup, GEOMETRY_MOTION)}
      {...{ [CANVAS_CARD_ATTR]: letterOf(index) }}
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
          <>
            <HeaderBand>
              <FrameHeader
                frame={frame}
                meta={meta}
                name={name}
                resolution={resolution}
              />
            </HeaderBand>
            <SelectableScreen
              selected={selected}
              onSelect={() => dispatch({ type: "select", id: frame.id })}
            >
              {screen}
            </SelectableScreen>
          </>
        )}
      </CanvasFrameView>
      {last ? <EdgeRail meta={meta} /> : null}
    </Placed>
  );
}

/** A frame's header band: as wide as its screen, `FRAME_HEAD_GAP` above it. */
function HeaderBand({ children }: { children: ReactNode }): ReactElement {
  return (
    <Placed x="fill" y={{ end: `calc(100% + ${String(FRAME_HEAD_GAP)}px)` }}>
      {children}
    </Placed>
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
      className={cn(!selected && "cursor-pointer")}
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

/** How far the divider's Side by side switch sits below the box's top edge, px. */
const SWIPE_PILL_INSET = 12;

/**
 * Swipe: the two frames in ONE box, B under A, A clipped at the divider — drag
 * the divider to wipe one design over the other. The divider carries the way
 * back to side by side at its top.
 */
function SwipeFrames({
  meta,
  layout,
  names,
  box,
}: {
  meta: PrototypeMeta;
  layout: FrameLayout;
  names: (frame: CanvasFrame) => string;
  /** Where the swipe box sits on the board (`placeFrames`, one slot). */
  box: FrameBox;
}): ReactElement | null {
  const { canvas, dispatch } = usePrototypeDetail();
  const [dragging, setDragging] = useState(false);
  const [a, b] = canvas.frames;
  if (a === undefined || b === undefined) return null;
  const at = canvas.swipeAt;

  const moveTo = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
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
            <Placed
              x={{ start: box.x, size: box.w }}
              y={{ start: box.y, size: box.h }}
              className={cn(hoverRevealGroup, GEOMETRY_MOTION)}
            >
              <HeaderBand>
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
              </HeaderBand>
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
                  const el = e.currentTarget.parentElement;
                  if (el) moveTo(e.clientX, el);
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
            </Placed>
          )}
        </CanvasFrameView>
      )}
    </CanvasFrameView>
  );
}
