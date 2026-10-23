import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import type { HintPlacement } from "../../core";
import {
  centerCard,
  placeCard,
  sideOrder,
  type Point,
  type Size,
} from "../internal/placement";
import type { HintRect } from "../internal/rect";
import "./hints.css";

/** A box the stage draws around: a rect in the frame's coordinates and its corner radius. */
export interface StageBox {
  /**
   * What the box is on (the anchor's key). A piece glides to a box with a new
   * id (the next step, another tip) and follows one with the same id exactly
   * (the anchor scrolling, or shifting with the layout).
   */
  readonly id: string;
  readonly rect: HintRect;
  readonly radius: number;
}

/**
 * The spotlight: `off`; `cover` (the welcome: a full scrim, no hole);
 * `hole` (a dim scrim with a ringed cut-out on `box`); `ring` (only the ring).
 */
export type StageSpot =
  | { readonly mode: "off" }
  | { readonly mode: "cover" }
  | { readonly mode: "hole" | "ring"; readonly box: StageBox };

export interface StageCard {
  /** `step` (a tour step: wider, dots and ×) or `tip` (narrower, Got it). */
  readonly variant: "step" | "tip";
  /** What the card sits beside; `null` centers it in the frame. */
  readonly target: StageBox | null;
  readonly placement: HintPlacement;
  readonly content: ReactNode;
}

export interface StageToast {
  /** Identity of one showing: a new id re-shows it. */
  readonly id: number;
  readonly content: ReactNode;
}

/**
 * Everything the stage draws, as data. The host derives it from the engine's
 * state; the stage keeps one element per piece and moves it, so going from any
 * scene to any other is animated by construction.
 */
export interface StageScene {
  readonly spot: StageSpot;
  /** Rings without a scrim: a tip's target, a step's cue. */
  readonly halos: readonly StageBox[];
  readonly card: StageCard | null;
  readonly welcome: ReactNode | null;
  readonly toast: StageToast | null;
}

export const EMPTY_SCENE: StageScene = {
  spot: { mode: "off" },
  halos: [],
  card: null,
  welcome: null,
  toast: null,
};

/** How many halos the stage keeps mounted (a tip's anchor, a step's cue). */
const HALO_SLOTS = 2;

/** How long a piece glides to a new target — `--hint-glide`'s duration in hints.css. */
const GLIDE_MS = 450;

/**
 * Draws a {@link StageScene} filling its positioned parent (the viewport, via
 * the host's overlay; a framed box in an exhibit). Click-through except the
 * cards and, during the welcome, the scrim.
 */
export function HintStage({ scene }: { scene: StageScene }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const frame = useMeasuredSize(frameRef);
  return (
    <div
      ref={frameRef}
      className="hint-stage"
      style={{ "--hint-glide-ms": `${GLIDE_MS}ms` } as React.CSSProperties}
    >
      <Spot spot={scene.spot} frame={frame} />
      {scene.spot.mode === "cover" && <div className="hint-blocker" />}
      {Array.from({ length: HALO_SLOTS }, (_, i) => (
        <Halo key={i} box={scene.halos[i] ?? null} />
      ))}
      <Card card={scene.card} frame={frame} />
      <Welcome content={scene.welcome} />
      <Toast toast={scene.toast} />
    </div>
  );
}

function Spot({ spot, frame }: { spot: StageSpot; frame: Size }) {
  const last = useLatest(
    spot.mode === "hole" || spot.mode === "ring" ? spot.box : null,
  );
  // The cover is a hole of no size at the frame's center, so the first step
  // opens it out onto its target.
  const box: StageBox =
    spot.mode === "cover" || last === null
      ? {
          id: "center",
          rect: {
            x: frame.width / 2,
            y: frame.height / 2,
            width: 0,
            height: 0,
          },
          radius: 0,
        }
      : last;
  const follow = useFollow(box.id);
  return (
    <Placed
      decorative
      data-mode={spot.mode}
      data-follow={follow}
      className="hint-spot"
      x={{ start: box.rect.x, size: box.rect.width }}
      y={{ start: box.rect.y, size: box.rect.height }}
      style={spot.mode === "cover" ? undefined : { borderRadius: box.radius }}
    />
  );
}

function Halo({ box }: { box: StageBox | null }) {
  const last = useLatest(box);
  const follow = useFollow(last?.id ?? null);
  if (last === null) return null;
  return (
    <Placed
      decorative
      data-on={box !== null}
      data-follow={follow}
      className="hint-halo"
      x={{ start: last.rect.x, size: last.rect.width }}
      y={{ start: last.rect.y, size: last.rect.height }}
      style={{ borderRadius: last.radius }}
    />
  );
}

function Card({ card, frame }: { card: StageCard | null; frame: Size }) {
  const shown = useLatest(card);
  const ref = useRef<HTMLDivElement>(null);
  const size = useMeasuredSize(ref);
  const on = card !== null;
  const snap = useSnapOnEnter(on);
  const follow = useFollow(shown?.target?.id ?? null);
  if (shown === null) return null;
  const at: Point = shown.target
    ? placeCard(shown.target.rect, size, frame, sideOrder(shown.placement))
    : centerCard(size, frame);
  return (
    <Placed
      ref={ref}
      role="dialog"
      aria-hidden={!on}
      inert={!on}
      data-on={on}
      data-follow={snap || follow}
      data-variant={shown.variant}
      className="hint-card"
      x={{ start: at.x }}
      y={{ start: at.y }}
    >
      {shown.content}
    </Placed>
  );
}

function Welcome({ content }: { content: ReactNode | null }) {
  const shown = useLatest(content);
  if (shown === null) return null;
  const on = content !== null;
  return (
    <div
      role="dialog"
      aria-modal={on}
      aria-hidden={!on}
      inert={!on}
      data-on={on}
      className="hint-welcome"
    >
      {shown}
    </div>
  );
}

function Toast({ toast }: { toast: StageToast | null }) {
  const shown = useLatest(toast);
  if (shown === null) return null;
  return (
    <div role="status" data-on={toast !== null} className="hint-toast">
      {shown.content}
    </div>
  );
}

/**
 * The last non-null value: what a piece keeps drawing while it fades out, so
 * leaving is a transition too rather than a cut.
 */
function useLatest<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/**
 * True while a piece tracks the same target it already sits on, so its moves
 * are the target's own (a scroll, a layout shift) and must land the same frame
 * — a glide would trail the element and only catch up once it stops. False
 * for one glide after the target changes, so moving to the next step or tip
 * is animated.
 */
function useFollow(id: string | null): boolean {
  const [shownId, setShownId] = useState(id);
  const [gliding, setGliding] = useState(false);
  if (id !== shownId) {
    setShownId(id);
    setGliding(true);
  }
  useEffect(() => {
    if (!gliding) return;
    // The glide's lifetime — one timer per target change, not a poll.
    const timer = setTimeout(() => setGliding(false), GLIDE_MS);
    return () => clearTimeout(timer);
  }, [gliding, shownId]);
  return !gliding;
}

/**
 * True for the first frame a piece is shown: it lands in place instead of
 * gliding from wherever it was when it last left.
 */
function useSnapOnEnter(on: boolean): boolean {
  const [wasOn, setWasOn] = useState(on);
  const entering = on && !wasOn;
  useEffect(() => {
    if (!entering) return;
    // One frame after the first paint at the new place: from then on, moves glide.
    const frame = requestAnimationFrame(() => setWasOn(true));
    return () => cancelAnimationFrame(frame);
  }, [entering]);
  if (!on && wasOn) setWasOn(false);
  return entering;
}

/**
 * An element's layout size (transforms excluded), measured before paint after
 * every render (new content) and on resize (a font landing, the viewport).
 */
function useMeasuredSize(ref: React.RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    setSize((prev) =>
      prev.width === next.width && prev.height === next.height ? prev : next,
    );
  };
  // No deps on purpose: after every render, since the content may have changed size.
  useLayoutEffect(measure);
  useResizeObserver(() => ref.current, measure);
  return size;
}
