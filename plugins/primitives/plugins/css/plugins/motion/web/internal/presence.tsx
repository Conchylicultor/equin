import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { EXIT_RATIO, overlayTiming } from "./overlay-timing";
import { prefersReducedMotion } from "./reduced-motion";

export type PresenceChild = ReactElement | null | false | undefined;

export interface PresenceProps {
  /**
   * The one surface that may be here — absent (`null` / `false` /
   * `undefined`) or an element. Its identity is its `key` (and its type):
   * a different key is a different surface, so the old one leaves while the
   * new one enters. The element must forward `ref` to its root DOM node
   * (`Pin`, `Placed`, `Surface`, `Layer`, `Column` … all do); one that does
   * not throws when it first leaves.
   */
  children: PresenceChild;
}

interface Entry {
  id: string;
  element: ReactElement;
  leaving: boolean;
  /** Arrived after the first render, so it plays an enter. */
  enter: boolean;
}

interface Exit {
  anim: Animation | null;
  undo: () => void;
}

const typeIds = new WeakMap<object, number>();
let nextTypeId = 0;

/** A stable name for an element's type: a tag, or a per-component number. */
function typeId(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type !== "object" && typeof type !== "function") return "?";
  if (type === null) return "?";
  let id = typeIds.get(type);
  if (id === undefined) {
    id = ++nextTypeId;
    typeIds.set(type, id);
  }
  return `#${id}`;
}

function identity(el: ReactElement): string {
  return `${typeId(el.type)}:${el.key ?? ""}`;
}

/** Whether a leaving surface is kept for an exit at all: never under reduced
 *  motion, nor where the theme gives overlays no duration (or there is no
 *  theme — a test document): the surface goes in the same render, as a bare
 *  conditional would. */
function exitsAnimate(): boolean {
  if (prefersReducedMotion()) return false;
  return overlayTiming(document.documentElement).enterMs > 0;
}

function reconcile(entries: readonly Entry[], child: PresenceChild): Entry[] {
  const nextId = child ? identity(child) : null;
  let animate: boolean | null = null;
  const retain = () => (animate ??= exitsAnimate());
  const next: Entry[] = [];
  let placed = false;
  for (const e of entries) {
    if (e.id === nextId && child) {
      // Still here — or back while leaving: the same instance stays.
      next.push({ ...e, element: child, leaving: false });
      placed = true;
    } else if (e.leaving) {
      next.push(e);
    } else if (retain()) {
      // Leaves with the element it last had, its state intact.
      next.push({ ...e, leaving: true });
    }
  }
  if (child && !placed && nextId !== null) {
    next.push({ id: nextId, element: child, leaving: false, enter: true });
  }
  return next;
}

function setRef(ref: Ref<unknown> | undefined, value: unknown): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: unknown }).current = value;
}

/**
 * Presence for a floating surface — the exit a surface cannot play itself,
 * since it is gone the moment its condition is false.
 *
 * `<Presence>{open ? <Pin key="card" …/> : null}</Presence>`:
 * - **Exit** — the leaving element stays drawn as the same instance, made
 *   `inert`, `aria-hidden` and click-through, taken out of the flow at its
 *   last box (so the surface that replaces it, or the siblings after it,
 *   never jump), and fades out with the overlay tokens' scale — the enter
 *   played back, in three quarters of its time. Then it is dropped. Its
 *   caller `ref` is released as it starts leaving, so a ref never points at
 *   a ghost.
 * - **Enter** — a surface that already animates itself on mount (a
 *   `Surface` overlay / float wears `surface-enter`) is left alone;
 *   anything else gets the same fade-and-scale in. Nothing enters on the
 *   first render.
 * - **Swap** — a new key leaves the old surface and enters the new one at
 *   once: a cross-fade in place.
 * - The same key coming back mid-exit cancels the exit: the instance stays.
 */
export function Presence({ children }: PresenceProps): ReactNode {
  const [state, setState] = useState(() => ({
    child: children,
    entries: children
      ? [
          {
            id: identity(children),
            element: children,
            leaving: false,
            enter: false,
          },
        ]
      : ([] as Entry[]),
  }));
  let entries = state.entries;
  if (state.child !== children) {
    entries = reconcile(state.entries, children);
    setState({ child: children, entries });
  }

  // Each surface's DOM node, written by the refs below. A plain map held for
  // the component's life (never rendered from), so the ref callbacks built
  // during render close over it without reading a React ref.
  const [nodes] = useState(() => new Map<string, HTMLElement>());
  const exits = useRef(new Map<string, Exit>());
  const entered = useRef(new Set<string>());

  /** The ref a surface is rendered with: it records the node, and — while
   *  the surface is live — feeds the caller's own ref. A leaving surface's
   *  ref is a different function, so React releases the caller's ref
   *  itself as the exit starts. */
  const refFor = (entry: Entry) => {
    const { id } = entry;
    const caller = entry.leaving
      ? undefined
      : (entry.element.props as { ref?: Ref<unknown> }).ref;
    return (el: HTMLElement | null) => {
      if (el) nodes.set(id, el);
      else nodes.delete(id);
      setRef(caller, el);
    };
  };

  const drop = (id: string) => {
    setState((s) => ({
      ...s,
      entries: s.entries.filter((e) => e.id !== id || !e.leaving),
    }));
  };

  useLayoutEffect(() => {
    for (const entry of entries) {
      const { id } = entry;
      const running = exits.current.get(id);
      if (entry.leaving && !running) {
        const el = nodes.get(id);
        if (!el)
          throw new Error(
            `[Presence] its child (${id}) must forward \`ref\` to its root DOM element`,
          );
        exits.current.set(
          id,
          startExit(el, () => drop(id)),
        );
      } else if (!entry.leaving && running) {
        running.anim?.cancel();
        running.undo();
        exits.current.delete(id);
      }
      if (entry.enter && !entry.leaving && !entered.current.has(id)) {
        entered.current.add(id);
        const el = nodes.get(id);
        if (!el)
          throw new Error(
            `[Presence] its child (${id}) must forward \`ref\` to its root DOM element`,
          );
        playEnter(el);
      }
    }
    // Forget the surfaces that are gone.
    const present = new Set(entries.map((e) => e.id));
    for (const id of [...nodes.keys()]) {
      if (!present.has(id)) nodes.delete(id);
    }
    for (const id of [...exits.current.keys()]) {
      if (!present.has(id)) exits.current.delete(id);
    }
    for (const id of [...entered.current]) {
      if (!present.has(id)) entered.current.delete(id);
    }
  });

  useLayoutEffect(() => {
    const running = exits.current;
    return () => {
      for (const exit of running.values()) exit.anim?.cancel();
    };
  }, []);

  return entries.map((entry) =>
    cloneElement(entry.element, { key: entry.id, ref: refFor(entry) } as never),
  );
}

/** Starts a leaving surface's exit; `done` drops it. */
function startExit(el: HTMLElement, done: () => void): Exit {
  const style = el.style;
  const saved = {
    position: style.position,
    left: style.left,
    top: style.top,
    width: style.width,
    height: style.height,
    margin: style.margin,
    pointerEvents: style.pointerEvents,
    inert: el.inert,
    ariaHidden: el.getAttribute("aria-hidden"),
  };
  const position = getComputedStyle(el).position;
  if (position === "static" || position === "relative") {
    // Out of the flow at the box it has now — what replaces it (or follows
    // it) takes its place at once, under the fading copy. `offset*` is
    // relative to the offset parent, which is what `absolute` positions
    // against; the parent itself may move as the copy leaves the flow (a
    // bottom-anchored stack shrinks from the top), so the copy is then
    // nudged back to where it was drawn.
    const before = el.getBoundingClientRect();
    const { offsetLeft, offsetTop, offsetWidth, offsetHeight } = el;
    style.position = "absolute";
    style.left = `${offsetLeft}px`;
    style.top = `${offsetTop}px`;
    style.width = `${offsetWidth}px`;
    style.height = `${offsetHeight}px`;
    style.margin = "0";
    const after = el.getBoundingClientRect();
    style.left = `${offsetLeft + before.left - after.left}px`;
    style.top = `${offsetTop + before.top - after.top}px`;
  }
  style.pointerEvents = "none";
  el.inert = true;
  el.setAttribute("aria-hidden", "true");
  const undo = () => {
    Object.assign(style, {
      position: saved.position,
      left: saved.left,
      top: saved.top,
      width: saved.width,
      height: saved.height,
      margin: saved.margin,
      pointerEvents: saved.pointerEvents,
    });
    el.inert = saved.inert;
    if (saved.ariaHidden === null) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", saved.ariaHidden);
  };

  const timing = overlayTiming(el);
  const duration = timing.enterMs * EXIT_RATIO;
  if (duration <= 0) {
    done();
    return { anim: null, undo };
  }
  const anim = el.animate([{ opacity: 0, scale: timing.scale, offset: 1 }], {
    duration,
    easing: timing.easing,
    fill: "forwards",
  });
  anim.onfinish = done;
  return { anim, undo };
}

/** Fades and scales a surface in — unless something in it already
 *  animates its own arrival. */
function playEnter(el: HTMLElement): void {
  const arriving = el
    .getAnimations({ subtree: true })
    .some((a) => a.playState === "running");
  if (arriving) return;
  const timing = overlayTiming(el);
  if (timing.enterMs <= 0 || prefersReducedMotion()) return;
  el.animate([{ opacity: 0, scale: timing.scale, offset: 0 }], {
    duration: timing.enterMs,
    easing: timing.easing,
  });
}
