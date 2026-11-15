import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Placed,
  pct,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  DRAG_THRESHOLD,
  wheelZoomFactor,
  type Size,
  type View,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/core";
import {
  FOCUS_CLASS,
  TAG_EDGE,
  Tag,
  frameClass,
  keyedAt,
  knobIcon,
  type SwipeCompareChrome,
  type SwipeCompareMode,
} from "./chrome";
import {
  canPan,
  drawnBox,
  initialZoom,
  visibleBox,
  wholeFit,
  zoomReducer,
  type Box,
  type ZoomAction,
  type ZoomState,
} from "./zoom-model";

/**
 * A comparison's zoom, held by the host so it can draw the controls
 * ({@link CompareZoomControls}) wherever it likes and hand the same zoom to
 * `<SwipeCompare zoom>`.
 */
export interface CompareZoom {
  readonly state: ZoomState;
  readonly dispatch: Dispatch<ZoomAction>;
}

/**
 * A zoom over two sides of `natural` pixel size, starting fitted to the width
 * (top first). The size is read once: a host comparing another pair keys the
 * component holding this hook by it, so the new pair starts fresh.
 */
export function useCompareZoom(natural: Size): CompareZoom {
  const [state, dispatch] = useReducer(zoomReducer, natural, (n) =>
    initialZoom(n),
  );
  return { state, dispatch };
}

/** Within this many px of the divider a press grabs it, even when a drag elsewhere pans. */
const HANDLE_HIT_PX = 14;

/** The zoom a key asks for, or null when the key is not one the zoom answers. */
function keyedZoom(
  e: KeyboardEvent<HTMLElement>,
  state: ZoomState,
): ZoomAction | null {
  // ⌘ / Ctrl / Alt stay the browser's (⌘+ is page zoom).
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "+":
    case "=":
      return { type: "step", dir: 1 };
    case "-":
    case "_":
      return { type: "step", dir: -1 };
    case "0":
      return state.viewport === null
        ? null
        : { type: "fit", fit: wholeFit(state.natural, state.viewport) };
    case "1":
      return { type: "actual-size" };
    case "w":
    case "W":
      return { type: "fit", fit: "width" };
    case "h":
    case "H":
      return { type: "fit", fit: "height" };
    default:
      return null;
  }
}

/** A press that may become a pan. */
interface Press {
  readonly x: number;
  readonly y: number;
  readonly from: View;
  moved: boolean;
}

/**
 * Drag to pan, over any frame: `begin` on press, `move` on every move (pans
 * once past the click threshold, when there is anything to pan to), `end` on
 * release — answering whether the press stayed a click.
 */
function usePan(zoom: CompareZoom) {
  const press = useRef<Press | null>(null);
  const [panning, setPanning] = useState(false);
  return {
    panning,
    begin(e: PointerEvent<HTMLElement>) {
      e.currentTarget.setPointerCapture(e.pointerId);
      press.current = {
        x: e.clientX,
        y: e.clientY,
        from: zoom.state.view,
        moved: false,
      };
    },
    move(e: PointerEvent<HTMLElement>) {
      const p = press.current;
      if (p === null) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        p.moved = true;
        if (canPan(zoom.state)) setPanning(true);
      }
      if (p.moved && canPan(zoom.state))
        zoom.dispatch({ type: "pan", from: p.from, dx, dy });
    },
    /** `true` when the press never moved — a click. */
    end(): boolean {
      const p = press.current;
      press.current = null;
      setPanning(false);
      return p !== null && !p.moved;
    },
    pressing(): boolean {
      return press.current !== null;
    },
  };
}

interface ZoomedProps {
  before: ReactNode;
  after: ReactNode;
  beforeLabel: string;
  afterLabel: string;
  mode: SwipeCompareMode;
  chrome: SwipeCompareChrome;
  at: number;
  setAt: (at: number) => void;
  zoom: CompareZoom;
  className: string | undefined;
}

/**
 * The zoomable comparison: each side drawn at the zoom's view inside its
 * viewport — the whole box (swipe, flip) or each half (side by side) — and
 * framed where the picture covers it, so a fitted picture keeps its frame and
 * an overflowing one fills the box. The wheel zooms around the pointer (pinch
 * faster), a drag pans; in swipe a press on the divider (or anywhere, when
 * there is nothing to pan) moves it.
 */
export function ZoomedCompare(props: ZoomedProps): ReactElement {
  const { mode, zoom, className } = props;
  if (mode === "side")
    return (
      <Stack
        direction="row"
        gap="smd"
        data-swipe-compare="side"
        className={cn("size-full", className)}
      >
        <Fill className="h-full">
          <Viewport zoom={zoom}>
            {(box) => (
              <PanFrame {...props} box={box} node={props.before}>
                {props.beforeLabel}
              </PanFrame>
            )}
          </Viewport>
        </Fill>
        <Fill className="h-full">
          <Viewport zoom={zoom}>
            {(box) => (
              <PanFrame {...props} box={box} node={props.after}>
                {props.afterLabel}
              </PanFrame>
            )}
          </Viewport>
        </Fill>
      </Stack>
    );
  return (
    <Viewport zoom={zoom} className={className}>
      {(box) =>
        mode === "flip" ? (
          <FlipFrame {...props} box={box} />
        ) : (
          <SwipeFrame {...props} box={box} />
        )
      }
    </Viewport>
  );
}

/**
 * One viewport: measured into the zoom, the wheel zooming around the pointer
 * (non-passive, so the pane under it does not scroll), and — once measured —
 * its frame drawn at the part of the box the picture covers.
 */
function Viewport({
  zoom,
  className,
  children,
}: {
  zoom: CompareZoom;
  className?: string;
  children: (box: Box) => ReactNode;
}): ReactElement {
  const { dispatch } = zoom;
  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const el = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      el.current = node;
      sizeRef(node);
    },
    [sizeRef],
  );

  useLayoutEffect(() => {
    if (size.width > 0 && size.height > 0)
      dispatch({
        type: "measure",
        viewport: { width: size.width, height: size.height },
      });
  }, [dispatch, size.width, size.height]);

  useEffect(() => {
    const node = el.current;
    if (node === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      dispatch({
        type: "zoom-by",
        factor: wheelZoomFactor(e),
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [dispatch]);

  const box = visibleBox(zoom.state);
  return (
    <div ref={ref} className={cn("relative size-full", className)}>
      {box === null ? null : children(box)}
    </div>
  );
}

/** One side, drawn at the view: placed inside the frame, which clips it. */
function SideLayer({
  node,
  state,
  box,
  clip,
}: {
  node: ReactNode;
  state: ZoomState;
  box: Box;
  clip?: string;
}): ReactElement {
  const d = drawnBox(state);
  return (
    <Layer style={clip === undefined ? undefined : { clipPath: clip }}>
      <Placed
        x={{ start: d.left - box.left, size: d.width }}
        y={{ start: d.top - box.top, size: d.height }}
      >
        {node}
      </Placed>
    </Layer>
  );
}

/** The frame's own placement at `box`, with its chrome. */
function frameProps(box: Box, chrome: SwipeCompareChrome, extra: string) {
  return {
    className: cn(
      placedClasses(),
      "select-none touch-none",
      frameClass(chrome),
      FOCUS_CLASS,
      extra,
    ),
    style: placedStyle(
      { start: box.left, size: box.width },
      { start: box.top, size: box.height },
    ),
    onDragStart: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
}

/** The pan cursor: a hand while there is anything to pan to. */
function panCursor(pannable: boolean, panning: boolean): string | null {
  if (!pannable) return null;
  return panning ? "cursor-grabbing" : "cursor-grab";
}

function SwipeFrame({
  before,
  after,
  beforeLabel,
  afterLabel,
  chrome,
  at,
  setAt,
  zoom,
  box,
}: ZoomedProps & { box: Box }): ReactElement {
  const [dragging, setDragging] = useState(false);
  const pan = usePan(zoom);
  const full = chrome === "full";
  const pannable = canPan(zoom.state);

  const atOf = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.width > 0 ? (e.clientX - rect.left) / rect.width : at;
  };
  const nearDivider = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.abs(e.clientX - (rect.left + at * rect.width)) <= HANDLE_HIT_PX;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Drag to swipe between ${beforeLabel} and ${afterLabel}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(at * 100)}
      tabIndex={0}
      data-swipe-compare="swipe"
      {...frameProps(
        box,
        chrome,
        panCursor(pannable, pan.panning) ?? "cursor-ew-resize",
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (pannable && !nearDivider(e)) {
          pan.begin(e);
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        setAt(atOf(e));
      }}
      onPointerMove={(e) => {
        if (dragging) setAt(atOf(e));
        else pan.move(e);
      }}
      onPointerUp={(e) => {
        if (dragging) setDragging(false);
        // A click off the divider still jumps it there.
        else if (pan.pressing() && pan.end()) setAt(atOf(e));
      }}
      onPointerCancel={() => {
        setDragging(false);
        pan.end();
      }}
      onDoubleClick={() => setAt(0.5)}
      onKeyDown={(e) => {
        const next = keyedAt(e.key, e.shiftKey, at);
        const zoomTo = next === null ? keyedZoom(e, zoom.state) : null;
        if (next === null && zoomTo === null) return;
        e.preventDefault();
        e.stopPropagation();
        if (next !== null) setAt(next);
        else if (zoomTo !== null) zoom.dispatch(zoomTo);
      }}
    >
      <SideLayer node={after} state={zoom.state} box={box} />
      <SideLayer
        node={before}
        state={zoom.state}
        box={box}
        clip={`inset(0 ${pct(1 - at)} 0 0)`}
      />
      <Placed
        x={{ start: pct(at), size: 2, shift: "-50%" }}
        y="fill"
        layer="raised"
        className={cn(
          "cursor-ew-resize",
          full
            ? "bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
            : dragging
              ? "bg-primary"
              : "bg-foreground",
        )}
      >
        {/* A grab band wider than the line, so the divider stays easy to take
            while a drag elsewhere pans. */}
        <Placed
          x={{ center: "50%", size: 2 * HANDLE_HIT_PX }}
          y="fill"
          className="cursor-ew-resize"
        />
        {full ? (
          <Pin to="center">
            {/* Fixed white / black like the divider and the tags — see the
                fitted surface. */}
            <Center
              className={cn(
                "size-7.5 rounded-full bg-white text-black shadow-md transition-transform",
                dragging && "scale-110",
              )}
            >
              <Icon icon={knobIcon} />
            </Center>
          </Pin>
        ) : null}
      </Placed>
      {full ? (
        <>
          <Tag to="bottom-left" hidden={at < TAG_EDGE}>
            {beforeLabel}
          </Tag>
          <Tag to="bottom-right" hidden={at > 1 - TAG_EDGE}>
            {afterLabel}
          </Tag>
        </>
      ) : null}
    </div>
  );
}

function FlipFrame({
  before,
  after,
  beforeLabel,
  afterLabel,
  chrome,
  zoom,
  box,
}: ZoomedProps & { box: Box }): ReactElement {
  const [showAfter, setShowAfter] = useState(true);
  const pan = usePan(zoom);
  const flip = () => setShowAfter((v) => !v);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={showAfter}
      aria-label={`Showing ${showAfter ? afterLabel : beforeLabel} — click or press Space to flip`}
      title="Click or Space to flip"
      data-swipe-compare="flip"
      {...frameProps(
        box,
        chrome,
        panCursor(canPan(zoom.state), pan.panning) ?? "cursor-pointer",
      )}
      onPointerDown={(e) => {
        if (e.button === 0) pan.begin(e);
      }}
      onPointerMove={(e) => pan.move(e)}
      onPointerUp={() => {
        if (pan.end()) flip();
      }}
      onPointerCancel={() => pan.end()}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          flip();
          return;
        }
        const zoomTo = keyedZoom(e, zoom.state);
        if (zoomTo === null) return;
        e.preventDefault();
        e.stopPropagation();
        zoom.dispatch(zoomTo);
      }}
    >
      <SideLayer node={before} state={zoom.state} box={box} />
      <Layer className={cn(!showAfter && "invisible")}>
        <SideLayer node={after} state={zoom.state} box={box} />
      </Layer>
      {chrome === "full" ? (
        <Tag to="bottom-left">{showAfter ? afterLabel : beforeLabel}</Tag>
      ) : null}
    </div>
  );
}

/** One half of side by side: its side at the shared view, panned by a drag. */
function PanFrame({
  node,
  chrome,
  zoom,
  box,
  children,
}: ZoomedProps & {
  box: Box;
  node: ReactNode;
  children: string;
}): ReactElement {
  const pan = usePan(zoom);
  return (
    <div
      tabIndex={0}
      aria-label={children}
      {...frameProps(
        box,
        chrome,
        panCursor(canPan(zoom.state), pan.panning) ?? "",
      )}
      onPointerDown={(e) => {
        if (e.button === 0) pan.begin(e);
      }}
      onPointerMove={(e) => pan.move(e)}
      onPointerUp={() => pan.end()}
      onPointerCancel={() => pan.end()}
      onKeyDown={(e) => {
        const zoomTo = keyedZoom(e, zoom.state);
        if (zoomTo === null) return;
        e.preventDefault();
        e.stopPropagation();
        zoom.dispatch(zoomTo);
      }}
    >
      <SideLayer node={node} state={zoom.state} box={box} />
      {chrome === "full" ? <Tag to="bottom-left">{children}</Tag> : null}
    </div>
  );
}
