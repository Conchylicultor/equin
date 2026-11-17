// The document-level half of reload readiness: engagement, visibility, and the
// two processes no primitive owns alone — a drag (dnd-kit, a movable, a native
// HTML drag, a slider: every one of them is a pointer pressed and moved, or a
// native drag) and media playback (every <video>/<audio> on the page). Both are
// caught here, at the document, so no library or feature can start one without
// its hold.

import {
  anyPopupOpen,
  subscribeOpenPopups,
} from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { holdReload, setReadinessFacts } from "./readiness-store";

/** How long after the last input the user still counts as engaged. */
export const RECENT_INPUT_MS = 10_000;

/** How far a pressed pointer moves before its press is a drag, in CSS px. */
export const DRAG_DISTANCE_PX = 4;

/** `<input>` types that are pressed, not typed into. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether `el` takes typed text (so focus in it means the user may be typing). */
export function isEditable(el: Element | null): boolean {
  if (el === null) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement)
    return !NON_TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** One pressed pointer: where it went down, and its drag hold once it moved. */
interface Press {
  x: number;
  y: number;
  release: (() => void) | null;
}

/**
 * Starts watching `doc` and feeding the readiness store; returns the stop.
 * Mounted once per page (the plugin's `Core.Root`).
 */
export function installGestureWatcher(doc: Document): () => void {
  const win = doc.defaultView;
  if (win === null) throw new Error("reload-readiness: document has no window");
  const presses = new Map<number, Press>();
  let nativeDrag: (() => void) | null = null;
  const playing = new Map<HTMLMediaElement, () => void>();

  // ── recent input: one deadline timer, re-armed only when it fires early ──
  let lastInputAt = 0;
  let recentTimer: ReturnType<typeof setTimeout> | null = null;
  const expireRecent = (): void => {
    const left = lastInputAt + RECENT_INPUT_MS - performance.now();
    if (left > 0) {
      recentTimer = setTimeout(expireRecent, left);
      return;
    }
    recentTimer = null;
    setReadinessFacts({ recentInput: false });
  };
  const noteInput = (): void => {
    lastInputAt = performance.now();
    if (recentTimer !== null) return;
    setReadinessFacts({ recentInput: true });
    recentTimer = setTimeout(expireRecent, RECENT_INPUT_MS);
  };

  // ── pointers: pressed → engaged; pressed and moved → a drag, held ──
  const endPress = (pointerId: number): void => {
    const press = presses.get(pointerId);
    if (press === undefined) return;
    presses.delete(pointerId);
    if (press.release !== null) press.release();
    setReadinessFacts({ pointerPressed: presses.size > 0 });
  };
  const endNativeDrag = (): void => {
    if (nativeDrag === null) return;
    nativeDrag();
    nativeDrag = null;
  };
  const onPointerDown = (e: PointerEvent): void => {
    noteInput();
    // A pointer event of any kind means a native drag is over: the browser
    // sends none while one runs, and a dragged source removed from the page
    // never gets its `dragend`.
    endNativeDrag();
    endPress(e.pointerId);
    presses.set(e.pointerId, { x: e.clientX, y: e.clientY, release: null });
    setReadinessFacts({ pointerPressed: true });
  };
  const onPointerMove = (e: PointerEvent): void => {
    endNativeDrag();
    const press = presses.get(e.pointerId);
    if (press === undefined) return;
    // Released where we did not see it (outside the window, a lost capture).
    if (e.buttons === 0) {
      endPress(e.pointerId);
      return;
    }
    if (
      press.release === null &&
      Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_DISTANCE_PX
    )
      press.release = holdReload("Drag");
  };
  const onPointerEnd = (e: PointerEvent): void => endPress(e.pointerId);
  const onDragStart = (): void => {
    noteInput();
    // The browser cancels the pointer that started a native drag.
    if (nativeDrag === null) nativeDrag = holdReload("Drag");
  };
  const onBlur = (): void => {
    // Pointers released while another window had focus are never reported.
    for (const id of [...presses.keys()]) endPress(id);
  };

  // ── focus in an editable ──
  const onFocusIn = (e: FocusEvent): void =>
    setReadinessFacts({
      editableFocused: e.target instanceof Element && isEditable(e.target),
    });
  const onFocusOut = (e: FocusEvent): void =>
    setReadinessFacts({
      editableFocused:
        e.relatedTarget instanceof Element && isEditable(e.relatedTarget),
    });

  // ── media playback: every <video>/<audio> on the page ──
  // A start is caught at the document (capture phase: media events do not
  // bubble); the stop is listened for on the element itself, since an element
  // removed from the page is paused there, outside the document.
  const MEDIA_STOPS = ["pause", "ended", "emptied"] as const;
  const onMediaPlay = (e: Event): void => {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement) || playing.has(el)) return;
    const release = holdReload("Playback");
    const stop = (): void => {
      for (const type of MEDIA_STOPS) el.removeEventListener(type, stop);
      playing.delete(el);
      release();
    };
    for (const type of MEDIA_STOPS) el.addEventListener(type, stop);
    playing.set(el, stop);
  };

  const onVisibility = (): void =>
    setReadinessFacts({ hidden: doc.visibilityState === "hidden" });

  const unsubscribePopups = subscribeOpenPopups(() =>
    setReadinessFacts({ popupOpen: anyPopupOpen() }),
  );
  setReadinessFacts({
    popupOpen: anyPopupOpen(),
    editableFocused: isEditable(doc.activeElement),
    hidden: doc.visibilityState === "hidden",
  });

  const listen: [EventTarget, string, (e: never) => void][] = [
    [doc, "pointerdown", onPointerDown],
    [doc, "pointermove", onPointerMove],
    [doc, "pointerup", onPointerEnd],
    [doc, "pointercancel", onPointerEnd],
    [doc, "dragstart", onDragStart],
    [doc, "dragend", endNativeDrag],
    [doc, "drop", endNativeDrag],
    [doc, "keydown", noteInput],
    [doc, "wheel", noteInput],
    [doc, "focusin", onFocusIn],
    [doc, "focusout", onFocusOut],
    [doc, "visibilitychange", onVisibility],
    [win, "blur", onBlur],
    [doc, "play", onMediaPlay],
  ];
  for (const [target, type, fn] of listen)
    target.addEventListener(type, fn as EventListener, {
      capture: true,
      passive: true,
    });

  return () => {
    for (const [target, type, fn] of listen)
      target.removeEventListener(type, fn as EventListener, { capture: true });
    unsubscribePopups();
    if (recentTimer !== null) clearTimeout(recentTimer);
    for (const id of [...presses.keys()]) endPress(id);
    endNativeDrag();
    for (const stop of [...playing.values()]) stop();
    setReadinessFacts({
      popupOpen: false,
      editableFocused: false,
      recentInput: false,
      pointerPressed: false,
    });
  };
}
