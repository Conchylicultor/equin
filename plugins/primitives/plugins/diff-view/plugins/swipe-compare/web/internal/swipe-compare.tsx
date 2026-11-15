import {
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

/** How the two sides are compared. */
export type SwipeCompareMode = "swipe" | "side" | "flip";

/**
 * What the primitive draws around the two sides.
 *
 * - `full` — a standalone comparison: a framed surface (rounded, ringed,
 *   clipped), a white divider with a round ‹› knob, and Before / After corner
 *   tags. What a pair of screenshots wants.
 * - `minimal` — for a host that draws its own frames and names (the prototype
 *   canvas): no frame, no knob, no tags, and a hairline divider in the
 *   foreground colour (the primary while dragged).
 */
export type SwipeCompareChrome = "full" | "minimal";

export interface SwipeCompareProps {
  /** The "before" side: on top in swipe (clipped at the divider), left side by side. */
  before: ReactNode;
  /** The "after" side: underneath in swipe, right side by side. */
  after: ReactNode;
  mode: SwipeCompareMode;
  /**
   * Where the swipe divider sits, 0 (all after) … 1 (all before). Given, the
   * component is controlled and reports moves through `onAtChange`; omitted,
   * it keeps its own position, starting centred.
   */
  at?: number;
  /** Every divider move (drag, click on the track, keys, double-click), clamped to 0…1. */
  onAtChange?: (at: number) => void;
  /** Defaults to "Before". */
  beforeLabel?: string;
  /** Defaults to "After". */
  afterLabel?: string;
  /**
   * The sides' width / height. Given, the comparison is the largest box of
   * that ratio that fits its parent (each side's, side by side), centred;
   * omitted, it fills its parent.
   */
  aspect?: number;
  /** Defaults to `full`. */
  chrome?: SwipeCompareChrome;
  className?: string;
}

const knobIcon = symbol("code");

/** One arrow key's step, and Shift's. */
const STEP = 0.02;
const BIG_STEP = 0.1;
/** Below / above this position the tag it would cover fades out. */
const TAG_EDGE = 0.14;
/** The gap between the two sides side by side, in px (the `smd` step). */
const SIDE_GAP_PX = 10;

/** A position clamped to the track. */
export function clampAt(at: number): number {
  return Math.min(1, Math.max(0, at));
}

/**
 * Where a key moves the divider from `at`, or null when the key is not one
 * the divider answers.
 */
export function keyedAt(
  key: string,
  shift: boolean,
  at: number,
): number | null {
  const step = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampAt(at - step);
    case "ArrowRight":
      return clampAt(at + step);
    case "Home":
      return 0;
    case "End":
      return 1;
    default:
      return null;
  }
}

/** A dark scrim for a tag laid over an image. Deliberately not a theme token:
 *  it must read against the picture under it, which no palette knows. */
const TAG_CLASS =
  "pointer-events-none rounded-sm bg-black/60 px-xsm py-2xs text-white backdrop-blur-sm transition-opacity";

const FOCUS_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * Two renderings of one thing compared: swiped one over the other (drag, click
 * the track, ←/→ (Shift ×5), Home/End, double-click to recentre), side by side,
 * or flipped between (click or Space). `before` / `after` are any nodes —
 * images, iframes — each filling its side.
 */
export function SwipeCompare({
  before,
  after,
  mode,
  at: atProp,
  onAtChange,
  beforeLabel = "Before",
  afterLabel = "After",
  aspect,
  chrome = "full",
  className,
}: SwipeCompareProps): ReactElement {
  const [ownAt, setOwnAt] = useState(0.5);
  const at = clampAt(atProp ?? ownAt);
  const setAt = (next: number) => {
    const clamped = clampAt(next);
    if (atProp === undefined) setOwnAt(clamped);
    onAtChange?.(clamped);
  };

  const body =
    mode === "side" ? (
      <SideBySide
        before={before}
        after={after}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        aspect={aspect}
        chrome={chrome}
        className={aspect === undefined ? className : undefined}
      />
    ) : mode === "flip" ? (
      <Flip
        before={before}
        after={after}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        aspect={aspect}
        chrome={chrome}
        className={aspect === undefined ? className : undefined}
      />
    ) : (
      <Swipe
        before={before}
        after={after}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        aspect={aspect}
        chrome={chrome}
        at={at}
        setAt={setAt}
        className={aspect === undefined ? className : undefined}
      />
    );
  if (aspect === undefined) return body;
  // A size container, so the box can be the largest of its ratio that fits
  // (`min(100cqw, 100cqh × ratio)`).
  return (
    <Center className={cn("size-full @container-[size]", className)}>
      {body}
    </Center>
  );
}

interface SurfaceProps {
  before: ReactNode;
  after: ReactNode;
  beforeLabel: string;
  afterLabel: string;
  aspect: number | undefined;
  chrome: SwipeCompareChrome;
  className: string | undefined;
}

/** One side's box: the fitted size for its ratio, or its parent's whole box. */
function fitStyle(aspect: number | undefined): CSSProperties | undefined {
  return aspect === undefined
    ? undefined
    : {
        width: `min(100cqw, calc(100cqh * ${String(aspect)}))`,
        aspectRatio: String(aspect),
      };
}

/**
 * A side's frame. `full` draws and clips one; `minimal` draws nothing and
 * clips nothing, so the host's own frames (their rounding, ring and shadow)
 * show whole.
 */
function frameClass(chrome: SwipeCompareChrome): string | null {
  return chrome === "full"
    ? cn(
        clipClasses({ axis: "both", fill: false }),
        "rounded-lg bg-muted shadow-lg ring-1 ring-border",
      )
    : null;
}

function Tag({
  children,
  to,
  hidden = false,
}: {
  children: string;
  to: "bottom-left" | "bottom-right";
  hidden?: boolean;
}): ReactElement {
  return (
    <Pin
      to={to}
      offset="sm"
      layer="raised"
      decorative
      className={cn(TAG_CLASS, hidden && "opacity-0")}
    >
      <Text variant="tag">{children}</Text>
    </Pin>
  );
}

function Swipe({
  before,
  after,
  beforeLabel,
  afterLabel,
  aspect,
  chrome,
  at,
  setAt,
  className,
}: SurfaceProps & {
  at: number;
  setAt: (at: number) => void;
}): ReactElement {
  const [dragging, setDragging] = useState(false);
  const full = chrome === "full";

  const moveTo = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setAt((e.clientX - rect.left) / rect.width);
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
      className={cn(
        "relative cursor-ew-resize touch-none select-none",
        aspect === undefined && "size-full",
        frameClass(chrome),
        FOCUS_CLASS,
        className,
      )}
      style={fitStyle(aspect)}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        moveTo(e);
      }}
      onPointerMove={(e) => {
        if (dragging) moveTo(e);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => setAt(0.5)}
      onKeyDown={(e) => {
        const next = keyedAt(e.key, e.shiftKey, at);
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        setAt(next);
      }}
    >
      <Layer>{after}</Layer>
      <Layer style={{ clipPath: `inset(0 ${pct(1 - at)} 0 0)` }}>
        {before}
      </Layer>
      <Placed
        x={{ start: pct(at), size: 2, shift: "-50%" }}
        y="fill"
        layer="raised"
        className={cn(
          full
            ? "bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
            : dragging
              ? "bg-primary"
              : "bg-foreground",
        )}
      >
        {full ? (
          <Pin to="center">
            {/* Fixed white / black like the divider and the tags, not theme
                tokens: the knob sits over an arbitrary picture, which no
                palette knows — a themed fill would vanish on a screenshot of
                the same theme. */}
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

function Flip({
  before,
  after,
  beforeLabel,
  afterLabel,
  aspect,
  chrome,
  className,
}: SurfaceProps): ReactElement {
  const [showAfter, setShowAfter] = useState(true);
  const flip = () => setShowAfter((v) => !v);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={showAfter}
      aria-label={`Showing ${showAfter ? afterLabel : beforeLabel} — click or press Space to flip`}
      title="Click or Space to flip"
      data-swipe-compare="flip"
      className={cn(
        "relative select-none",
        aspect === undefined && "size-full",
        frameClass(chrome),
        FOCUS_CLASS,
        className,
      )}
      style={fitStyle(aspect)}
      onDragStart={(e) => e.preventDefault()}
      onClick={flip}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        flip();
      }}
    >
      <Layer>{before}</Layer>
      <Layer className={cn(!showAfter && "invisible")}>{after}</Layer>
      {chrome === "full" ? (
        <Tag to="bottom-left">{showAfter ? afterLabel : beforeLabel}</Tag>
      ) : null}
    </div>
  );
}

function SideBySide({
  before,
  after,
  beforeLabel,
  afterLabel,
  aspect,
  chrome,
  className,
}: SurfaceProps): ReactElement {
  const pane = (node: ReactNode, label: string) => (
    <Fill>
      <div
        className={cn(
          "relative",
          aspect === undefined && "h-full",
          frameClass(chrome),
        )}
        style={
          aspect === undefined ? undefined : { aspectRatio: String(aspect) }
        }
      >
        <Layer>{node}</Layer>
        {chrome === "full" ? <Tag to="bottom-left">{label}</Tag> : null}
      </div>
    </Fill>
  );
  return (
    <Stack
      direction="row"
      gap="smd"
      data-swipe-compare="side"
      className={cn(aspect === undefined && "size-full", className)}
      style={
        aspect === undefined
          ? undefined
          : {
              width: `min(100cqw, calc(100cqh * ${String(2 * aspect)} + ${String(SIDE_GAP_PX)}px))`,
            }
      }
    >
      {pane(before, beforeLabel)}
      {pane(after, afterLabel)}
    </Stack>
  );
}
