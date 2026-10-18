import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  consumeWindowIntro,
  type FloatingWindow,
  type WindowId,
} from "./use-floating-windows";
import { snapBox } from "./use-snap";
import { peekMinimizeTarget } from "../internal/minimize-target";
import { useWorkAreaReserve } from "../internal/work-area";
import { usePeekedWindow } from "../internal/peek";
import { useOverviewSlots } from "../internal/overview";

/**
 * Window motion — the presentational animation layer for floating windows.
 *
 * Gives a window's state changes the mockup's motion WITHOUT touching the
 * geometry store (which stays the single source of truth for the box). It owns
 * three things:
 *
 *  1. A transient **interaction** channel (a module-global set of windows being
 *     pointer-dragged/resized) so the box `transition` is suppressed during
 *     direct manipulation — a window must track the cursor 1:1, never lag behind
 *     an ease. Released over a snap zone, the interaction ends in the same
 *     commit the snapped box is written, so the snap itself animates.
 *  2. A **reduced-motion** read, so every animation degrades to the instant
 *     behaviour under `prefers-reduced-motion: reduce`.
 *  3. {@link useFloatingWindowStyle}: the per-window phase machine that derives
 *     the animated container style (box + corner + elevation + transform +
 *     opacity + transition), pushed onto the keep-alive container by the chrome.
 *     It also folds in the two desktop-wide states that move windows without
 *     touching their box: the overview (each window's grid transform) and the
 *     shelf's peek (the peeked window raised, the others faded).
 *
 * All motion is expressed as inline `transition`/`transform` on the box style the
 * chrome already pushes — no keyframes, no extra DOM, no change to the generic
 * surface body. Timings and curves are the mockup's `.win.animating`.
 */

/** Box geometry tween (snap / maximize / restore / tile). */
const BOX_MS = 220;
const EASE_BOX = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Transform tween (open, minimise / restore, overview). */
const TRANSFORM_MS = 320;
const EASE_TRANSFORM = "cubic-bezier(0.3, 0.7, 0.2, 1)";
/** Opacity tween paired with a transform tween. */
const OPACITY_MS = 280;
/** Minimise / restore / open: when the tween has settled and its phase ends. */
const SETTLE_MS = 340;
/**
 * Window close (exit) tween — scale-down + fade, the reverse of the intro pop.
 * Single-sourced so the surface host's exit-presence retention and this tween
 * read the same duration (the floating placement sets `exitDurationMs = CLOSE_MS`).
 */
export const CLOSE_MS = 240;
/** Elevation cross-fade when focus moves between windows. */
const SHADOW_MS = 200;
/** The peek fade of the windows that are not peeked. */
const PEEK_FADE_MS = 180;
/** What the windows that are not peeked fade to (mockup `.peeking`). */
const PEEK_DIM_OPACITY = 0.07;

/** The window corner (mockup `--r-win`); a maximised window is square. */
const WINDOW_RADIUS = 12;

/**
 * Window elevation per focus state — the mockup's `--shadow-active` /
 * `--shadow-idle` (its dark-theme values: windows sit on a wallpaper, never on
 * a page, so the deep shadow reads the same under any app theme). Literal on
 * purpose: no theme token describes a window lifted off a desktop.
 */
const SHADOW_FOCUSED =
  "0 0 0 0.5px rgba(0,0,0,0.7), 0 2px 4px rgba(0,0,0,0.25), 0 16px 32px -6px rgba(0,0,0,0.45), 0 40px 80px -16px rgba(0,0,0,0.6)";
const SHADOW_UNFOCUSED =
  "0 0 0 0.5px rgba(0,0,0,0.6), 0 8px 20px -6px rgba(0,0,0,0.4)";
/** The peeked window: lifted, ringed in the accent. */
const SHADOW_PEEKED = `${SHADOW_FOCUSED}, 0 0 0 2px var(--primary)`;
/** The peeked window rises over every window (dense z `1..N`) yet stays under the desktop's overlays. */
const PEEK_Z = "calc(var(--z-overlay) - 1)";

/**
 * Where a minimise lands when the shelf names no target (no resolver, or its
 * entry is off screen): shrunk and dropped straight down, scaled about the
 * window's bottom edge so it reads as falling into the shelf.
 */
const FALLBACK_AIM: Aim = {
  transform: "translateY(40%) scale(0.2)",
  origin: "bottom center",
};

/** A minimise tween's far end: the transform and the origin it scales about. */
interface Aim {
  transform: string;
  origin: string;
}

/**
 * The minimise tween's far end for a window: its centre translated onto the
 * centre of the shelf entry that stands for it, scaled down to a speck (mockup
 * `minimize`). Measured from the container's untransformed layout box
 * (`offsetLeft/Top` ignore transforms), so it is right mid-tween too; falls
 * back to {@link FALLBACK_AIM} without a target. An event-time read.
 */
function minimizeAim(tabId: string, windowId: WindowId): Aim {
  const target = peekMinimizeTarget(windowId);
  const el = document.querySelector<HTMLElement>(
    `[data-tab-id="${CSS.escape(tabId)}"]`,
  );
  const parent = el?.offsetParent;
  if (!target || !el || !(parent instanceof HTMLElement)) return FALLBACK_AIM;
  const p = parent.getBoundingClientRect();
  const cx = p.left + el.offsetLeft + el.offsetWidth / 2;
  const cy = p.top + el.offsetTop + el.offsetHeight / 2;
  const tx = target.left + target.width / 2;
  const ty = target.top + target.height / 2;
  return {
    transform: `translate(${tx - cx}px, ${ty - cy}px) scale(0.06)`,
    origin: "50% 50%",
  };
}

// ---------------------------------------------------------------------------
// Interaction channel — windows currently being pointer-dragged or resized.
// Module-global by design, mirroring this plugin's other transient channels
// (geometry, snap preview): the writer (chrome drag handlers) and reader
// (the style hook) live in the same single focused floating surface.
// ---------------------------------------------------------------------------

// page-global by design: a transient set of windows under active pointer drag/resize, shared between the chrome's drag handlers and the per-window style hook (mirrors this plugin's module-global geometry + snap-preview channels).
const interacting = new Set<WindowId>();
const interactionSubs = new Set<() => void>();

function notifyInteraction() {
  for (const fn of interactionSubs) fn();
}

/** Mark a window as under active pointer manipulation (drag / resize start). */
export function beginWindowInteraction(id: WindowId) {
  if (interacting.has(id)) return;
  interacting.add(id);
  notifyInteraction();
}

/** Clear a window's active-manipulation flag (drag / resize end). */
export function endWindowInteraction(id: WindowId) {
  if (!interacting.delete(id)) return;
  notifyInteraction();
}

/** Reactive read: is this window being pointer-dragged/resized right now? */
function useWindowInteracting(id: WindowId): boolean {
  return useSyncExternalStore(
    (cb) => {
      interactionSubs.add(cb);
      return () => interactionSubs.delete(cb);
    },
    () => interacting.has(id),
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Reduced motion.
// ---------------------------------------------------------------------------

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Per-window style machine.
// ---------------------------------------------------------------------------

/**
 * Animation phase of one window's visible chrome. Resting phases (`normal`,
 * `minimized`) hold a static style; the three transient phases run a one-shot
 * tween then settle:
 *  - `intro`     — opening pop (scale-in + fade), settles to `normal`.
 *  - `minimizing`— exit toward the dock, settles to `minimized` (display:none).
 *  - `restoring` — reverse of minimizing, settles to `normal`.
 *  - `closing`   — close exit (scale-down + fade, reverse of `intro`); has no
 *                  settle phase — the host unmounts the chrome after the
 *                  exit-presence retention elapses.
 */
type Phase =
  "intro" | "normal" | "minimizing" | "minimized" | "restoring" | "closing";

export interface WindowStyle {
  /** The animated container box style (pushed onto the keep-alive container). */
  containerStyle: CSSProperties;
  /** Whether the window is fully hidden (display:none) — drives the content inset. */
  hidden: boolean;
}

/**
 * Derive the animated container style for one floating window, given the window,
 * the tab painting it and whether that tab is its shown member. Returns a
 * memoized box style plus a `hidden` flag; the chrome pushes the style onto the
 * host container and uses `hidden` to gate the content inset.
 *
 * Only the ACTIVE member animates: inactive group members (and reduced-motion)
 * collapse to the instant show/hide. The box itself always comes from the
 * geometry store (a snapped one through `snapBox`, inside the work area); this
 * layer only adds the corner, the elevation, `transition` (suppressed mid-drag)
 * and the transform/opacity of the tweens, the overview and the peek on top.
 *
 * `onActiveDesktop` folds the virtual-desktop visibility in: a window on a
 * non-active desktop is `display:none` (it stays mounted = keep-alive, so a
 * desktop switch is instant with no remount), with NO transition — it is not an
 * animated minimize, it simply isn't on this desktop.
 */
export function useFloatingWindowStyle(
  win: FloatingWindow,
  tabId: string,
  isActive: boolean,
  closing: boolean,
  focused: boolean,
  onActiveDesktop: boolean,
): WindowStyle {
  const reduced = usePrefersReducedMotion();
  const dragging = useWindowInteracting(win.id);
  const reserve = useWorkAreaReserve();
  const peeked = usePeekedWindow();
  const overviewSlot = useOverviewSlots()?.get(win.id);
  const geo = win.geo;

  // Open pop only for a genuinely fresh window (minted, not hydrated/merged) that
  // is the shown member — consumed once so a placement round-trip never re-plays.
  const [phase, setPhase] = useState<Phase>(() =>
    !reduced && isActive && consumeWindowIntro(win.id) ? "intro" : "normal",
  );
  // Two-step arm for the enter tweens (intro / restoring): render the "from"
  // frame first, then flip `play` after it painted so the browser tweens to the
  // "to" frame.
  const [play, setPlay] = useState(false);
  // The minimise / restore tween's far end, measured once the window is laid
  // out for the tween (null until then).
  const [aim, setAim] = useState<Aim | null>(null);
  // Box transitions arm only AFTER the first commit, so the window's initial
  // placement (mount / hydrate / placement switch) snaps in instead of sliding
  // from the previous box.
  const [boxReady, setBoxReady] = useState(false);
  // The `minimized` value the phase machine has reacted to.
  const [seenMinimized, setSeenMinimized] = useState(geo.minimized);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setBoxReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // React to a minimize/restore flip — in a LAYOUT effect, so the frame in
  // between (resting phase, already flagged minimized → hidden) is never
  // painted and the tween's first frame measures a laid-out window.
  // Reduced-motion (or an inactive member) jumps straight to the resting phase.
  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- animation phase machine: a minimize/restore flip in geo.minimized drives a timed CSS tween. The phase, aim and play arm are temporal tween stages, not derivable in render; `seenMinimized` gates this to an actual edge so it fires once per flip. */
    if (geo.minimized === seenMinimized) return;
    setSeenMinimized(geo.minimized);
    if (reduced || !isActive) {
      setPhase(geo.minimized ? "minimized" : "normal");
      return;
    }
    setPlay(false);
    setAim(null);
    setPhase(geo.minimized ? "minimizing" : "restoring");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [geo.minimized, seenMinimized, isActive, reduced]);

  // Aim the minimise / restore tween at the shelf entry, measured while the
  // window is laid out at rest (before paint, so the rest frame never shows).
  useLayoutEffect(() => {
    if ((phase !== "minimizing" && phase !== "restoring") || aim !== null)
      return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a layout measurement (the window's box against the shelf entry's) that the tween's far end is derived from; it can only be read once the window is laid out.
    setAim(minimizeAim(tabId, win.id));
  }, [phase, aim, tabId, win.id]);

  // Enter the close exit tween when the host flags this (whole-)window closing.
  // Reduced-motion / inactive members get no tween: the host unmounts the chrome
  // after the retention timer regardless, so the degrade is just an instant
  // disappearance (acceptable).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- animation phase machine: the host flagging `closing` arms a one-shot exit tween (setPlay(false) renders the "from" frame, setPhase("closing") enters the exit stage; the phase-timer effect flips play to tween to "to"). These are temporal tween stages keyed off an external close signal, not derivable in render. */
    if (!closing || !isActive || reduced) return;
    setPlay(false);
    setPhase("closing");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [closing, isActive, reduced]);

  // One-shot phase timers. A single deferred settle per transient phase (not a
  // polling loop): arm the enter "play" frame, then advance to the resting phase
  // once the tween's duration has elapsed.
  useEffect(() => {
    if (phase === "intro" || (phase === "restoring" && aim !== null)) {
      const raf = requestAnimationFrame(() => setPlay(true));
      const t = setTimeout(() => setPhase("normal"), SETTLE_MS);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(t);
      };
    }
    if (phase === "minimizing" && aim !== null) {
      const t = setTimeout(() => setPhase("minimized"), SETTLE_MS);
      return () => clearTimeout(t);
    }
    if (phase === "closing") {
      // Arm the close tween's "to" frame; NO settle timer — the host unmounts the
      // chrome once the exit-presence retention (CLOSE_MS) elapses.
      const raf = requestAnimationFrame(() => setPlay(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [phase, aim]);

  return useMemo<WindowStyle>(() => {
    const box: CSSProperties = geo.snap
      ? snapBox(geo.snap, reserve)
      : { left: geo.x, top: geo.y, width: geo.w, height: geo.h };

    // Fully hidden: off the active virtual desktop, an inactive member, a
    // settled-minimized window, or a window that is flagged minimized while
    // resting (hydrated-minimized / reduced). Off-desktop hides unconditionally;
    // otherwise a `closing` window keeps painting to animate.
    const hidden =
      !onActiveDesktop ||
      (phase !== "closing" &&
        (!isActive ||
          phase === "minimized" ||
          ((phase === "normal" || phase === "intro") && geo.minimized)));

    const isPeeked = peeked === win.id;
    let transform: string | undefined;
    let opacity: number | undefined;
    let transformOrigin: string | undefined;
    if (phase === "intro") {
      transform = play ? "none" : "scale(0.96)";
      opacity = play ? 1 : 0;
      transformOrigin = "center";
    } else if (phase === "minimizing") {
      // Until the aim is measured the window rests where it is.
      transform = aim?.transform;
      opacity = aim ? 0 : 1;
      transformOrigin = aim?.origin;
    } else if (phase === "restoring") {
      transform = play ? "none" : aim?.transform;
      opacity = play ? 1 : 0;
      transformOrigin = aim?.origin;
    } else if (phase === "closing") {
      // Reverse of `intro`: shrink + fade about the center as the window exits.
      transform = play ? "scale(0.96)" : "none";
      opacity = play ? 0 : 1;
      transformOrigin = "center";
    } else {
      // At rest: the overview glides it into its grid cell; a peek elsewhere
      // fades it almost away.
      if (overviewSlot) {
        transform = overviewSlot.transform;
        transformOrigin = "center";
      }
      if (peeked !== null && !isPeeked) opacity = PEEK_DIM_OPACITY;
    }

    const motion = `transform ${TRANSFORM_MS}ms ${EASE_TRANSFORM}, opacity ${OPACITY_MS}ms ease`;
    const parts: string[] = [];
    if (boxReady && !dragging && !reduced && phase === "normal") {
      for (const p of ["left", "top", "width", "height", "border-radius"])
        parts.push(`${p} ${BOX_MS}ms ${EASE_BOX}`);
      parts.push(
        `box-shadow ${SHADOW_MS}ms ease`,
        `transform ${TRANSFORM_MS}ms ${EASE_TRANSFORM}`,
        `opacity ${PEEK_FADE_MS}ms ease`,
      );
    }
    if ((phase === "intro" || phase === "restoring") && play)
      parts.push(motion);
    if (phase === "minimizing" && aim) parts.push(motion);
    if (phase === "closing")
      parts.push(
        `transform ${CLOSE_MS}ms ${EASE_TRANSFORM}`,
        `opacity ${CLOSE_MS}ms ease`,
      );

    const containerStyle: CSSProperties = {
      ...box,
      zIndex: isPeeked ? PEEK_Z : geo.z,
      borderRadius: geo.snap === "maximize" ? 0 : WINDOW_RADIUS,
      boxShadow: isPeeked
        ? SHADOW_PEEKED
        : focused
          ? SHADOW_FOCUSED
          : SHADOW_UNFOCUSED,
      ...(hidden ? { display: "none" } : null),
      ...(transform ? { transform, willChange: "transform, opacity" } : null),
      ...(opacity !== undefined ? { opacity } : null),
      ...(transformOrigin ? { transformOrigin } : null),
      ...(parts.length ? { transition: parts.join(", ") } : null),
    };

    return { containerStyle, hidden };
  }, [
    geo,
    win.id,
    reserve,
    isActive,
    phase,
    play,
    aim,
    boxReady,
    dragging,
    reduced,
    focused,
    onActiveDesktop,
    peeked,
    overviewSlot,
  ]);
}
