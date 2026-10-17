import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { announce } from "@plugins/primitives/plugins/announce/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  COMPACT_BELOW,
  gridMove,
  imageCapabilities,
  isZoomed,
  matchViewerKey,
  type GridMove,
  type Rect,
  type Size,
  type ViewerAction,
  type ViewerMode,
} from "../../core";
import { copyImage, downloadImage } from "../internal/file-actions";
import { createDecodedCache, isLoadFailure } from "../internal/decoded-cache";
import {
  knownSize,
  pickSrc,
  pixelRatio,
  shownEdge,
} from "../internal/pick-src";
import { createStageGestures } from "../internal/stage-gestures";
import { sameImage, type ViewerImage } from "../internal/types";
import { createViewController } from "../internal/view-controller";
import { ViewStore, readMeta, type ViewState } from "../internal/view-store";
import { writeViewPrefs } from "../internal/view-prefs";
import { ImageGrid } from "./viewer-grid";
import { ThumbnailStrip } from "./viewer-strip";
import {
  BottomBar,
  HOVERED_CHROME,
  Minimap,
  NavArrows,
  TopBar,
} from "./viewer-chrome";

export interface ImageViewerProps {
  /** Every image the viewer can step through, in order. */
  images: readonly ViewerImage[];
  /** The one on screen. Must index into `images`. */
  index: number;
  /** ← / → or an arrow button asked for another image. */
  onIndexChange(index: number): void;
  /** The close animation has finished; unmount the viewer now. */
  onClose(): void;
  /**
   * The on-page element each image was opened from (its thumbnail). The viewer
   * grows the image out of it on open and shrinks it back into it on close,
   * hides it while its image is on screen (so the image looks lifted out of
   * the page, not copied), and returns focus to it — or to the nearest
   * focusable element around it — on close. `null`, or omitted: fade instead.
   */
  originOf?: (index: number) => Element | null;
}

/** How long the shrink-back takes; the viewer unmounts after it. */
const CLOSE_MS = 280;
/** How long a fade takes (reduced motion, or nowhere to shrink back to). */
const FADE_MS = 200;
/** How long a step may wait for its image before a spinner joins the old one. */
const SLOW_SWAP_MS = 150;
/** Decoded images a viewer keeps: the one on screen, its neighbours, a sharper copy. */
const DECODED_MAX = 6;
/** A zoom that outgrows its copy asks for this much more, so a slow zoom does
 *  not fetch every size on the way. */
const SHARPEN_HEADROOM = 1.5;
/** Quiet time after a preference change before it is saved. */
const PREFS_SETTLE_MS = 400;
/** Quiet time before the controls fade while zoomed. */
const IDLE_MS = 2200;
/** How long the "Image copied" pill stays up. */
const STATUS_MS = 1600;
/** How long the first-open hint stays up. */
const HINT_MS = 3200;

/** Motion for a click, key or button zoom; a drag or wheel zoom writes with
 *  no transform transition, so the image follows the pointer exactly. */
const TRANSITION_ZOOM =
  "transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms";
const TRANSITION_FADE = "opacity 200ms";

// The first-open hint shows once per page load, not on every open. A page-wide
// fact on purpose (not per viewer): it is about whether this user has been told.
let hintShown = false;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `el`'s box in stage coordinates, when any of it is on screen. */
function rectOnStage(el: Element, stage: Element): Rect | null {
  const r = el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const onScreen =
    r.width > 0 &&
    r.bottom > s.top &&
    r.top < s.bottom &&
    r.right > s.left &&
    r.left < s.right;
  return onScreen
    ? {
        left: r.left - s.left,
        top: r.top - s.top,
        width: r.width,
        height: r.height,
      }
    : null;
}

/** An already-loaded `<img>` thumbnail knows the natural size before the
 *  viewer's own copy has loaded. */
function loadedSize(el: Element | null): Size | null {
  return el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0
    ? { width: el.naturalWidth, height: el.naturalHeight }
    : null;
}

/** What the stage draws: which image, from which URL (a copy of at least
 *  `edge` device pixels, or the original: `Infinity`), at what natural size,
 *  and how it got there — the open (fades / grows in once loaded), a step
 *  (decoded, painted at once), or a sharper copy of the same image. */
interface Shown {
  image: ViewerImage;
  url: string;
  edge: number;
  natural: Size | null;
  via: "open" | "swap" | "sharper";
}

/** The copy the stage draws `image` with, fitted to the window. A copy only
 *  when the original's size is known: the zoom is computed from it. */
function stageCopy(image: ViewerImage): Pick<Shown, "image" | "url" | "edge"> {
  const size = knownSize(image);
  if (!size) return { image, url: image.src, edge: Infinity };
  const edge = shownEdge(size, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const url = pickSrc(image, edge, true);
  return { image, url, edge: url === image.src ? Infinity : edge };
}

/** Write the store's view onto the image element: the per-frame path that
 *  never goes through React. */
function writeImage(img: HTMLImageElement, s: ViewState, animate: boolean) {
  const { scale, x, y } = s.view;
  img.style.transition = animate ? TRANSITION_ZOOM : TRANSITION_FADE;
  img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  // Past 100% the pixels are the content — show them square, not smeared.
  img.style.imageRendering = scale > 1.001 ? "pixelated" : "";
  img.style.opacity = s.imageVisible ? "1" : "0";
}

/** Tab and Shift+Tab cycle through the viewer's own buttons only. */
function cycleFocus(e: ReactKeyboardEvent, root: HTMLElement) {
  e.preventDefault();
  const items = [
    ...root.querySelectorAll<HTMLElement>("button:not(:disabled)"),
  ];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    at < 0
      ? e.shiftKey
        ? items.length - 1
        : 0
      : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
}

/** Where focus goes on close: the thumbnail's own control, else whatever had
 *  focus before the viewer opened. */
function restoreFocus(origin: Element | null, previous: Element | null) {
  const target =
    origin?.closest<HTMLElement>("button, a[href], [tabindex]") ??
    (previous instanceof HTMLElement ? previous : null);
  target?.focus({ preventScroll: true });
}

/** The keyboard's mode for a state: the slideshow outranks the layout. */
function modeOf(s: ViewState): ViewerMode {
  return s.slideshow ? "slideshow" : s.layout;
}

/** A focused control owns these keys itself: a button's Enter / Space click,
 *  the slider's arrows. Only Esc still reaches the viewer from one. */
function ownedByFocusedControl(e: ReactKeyboardEvent): boolean {
  const t = e.target;
  if (e.key === "Escape") return false;
  if (t instanceof HTMLInputElement) return true;
  return t instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ");
}

/** The grid's column count, read from the laid-out track list (the browser
 *  decides how many `auto-fill` tracks fit). */
function columnsOf(grid: HTMLElement | null): number {
  if (!grid) return 1;
  return getComputedStyle(grid).gridTemplateColumns.split(" ").length;
}

/** `images[index]`, or a loud failure: an index outside the list is a caller bug. */
function imageAt(images: readonly ViewerImage[], index: number): ViewerImage {
  const image = images[index];
  if (!image) {
    throw new Error(
      `ImageViewer: index ${index} is outside the ${images.length} image(s) it was given`,
    );
  }
  return image;
}

/**
 * The full-window image viewer, controlled: the caller owns which image is on
 * screen and when the viewer is mounted. Most callers never render this —
 * `ViewerThumbnail` / `useImageViewerTrigger` open it through a gallery. It is
 * for sites that have images but no thumbnails of their own (mail HTML).
 */
export function ImageViewer(props: ImageViewerProps) {
  return (
    <ViewStore.Provider>
      <ViewerFrame {...props} />
    </ViewStore.Provider>
  );
}

function ViewerFrame({
  images,
  index,
  onIndexChange,
  onClose,
  originOf,
}: ImageViewerProps) {
  const current = imageAt(images, index);
  const store = ViewStore.useStoreApi();
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const previousFocus = useRef<Element | null>(null);
  const timers = useRef(new Set<number>());

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
    return id;
  }, []);
  const cancel = useCallback((id: number | null) => {
    if (id === null) return;
    window.clearTimeout(id);
    timers.current.delete(id);
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
    };
  }, []);

  const originRect = useEventCallback((): Rect | null => {
    const el = originOf?.(index) ?? null;
    const stage = stageRef.current;
    return el && stage ? rectOnStage(el, stage) : null;
  });
  const [ctl] = useState(() =>
    createViewController(store, {
      originRect,
      reducedMotion: prefersReducedMotion,
      afterPaint: (fn) =>
        requestAnimationFrame(() => requestAnimationFrame(fn)),
    }),
  );

  // --- closing -------------------------------------------------------------
  const requestClose = useEventCallback(() => {
    if (store.getState().phase === "closing") return;
    if (document.fullscreenElement === rootRef.current)
      void document.exitFullscreen();
    ctl.beginClose();
    const shrinks = store.getState().imageVisible && !prefersReducedMotion();
    later(
      () => {
        restoreFocus(originOf?.(index) ?? null, previousFocus.current);
        onClose();
      },
      shrinks ? CLOSE_MS : FADE_MS,
    );
  });
  const goTo = useEventCallback((next: number) => {
    if (
      next === index ||
      next < 0 ||
      next >= images.length ||
      store.getState().phase === "closing"
    )
      return;
    onIndexChange(next);
  });
  // The slideshow loops; the single view stops at either end (its spent arrow
  // disappears).
  const go = useEventCallback((delta: 1 | -1) => {
    if (store.getState().slideshow && images.length > 1)
      goTo((index + delta + images.length) % images.length);
    else goTo(index + delta);
  });

  // A plain click closes — except in the slideshow, where it advances
  // (wrapping round), as a slideshow's click does.
  const plainClick = useEventCallback(() => {
    if (store.getState().slideshow) goTo((index + 1) % images.length);
    else requestClose();
  });
  const [gestures] = useState(() =>
    createStageGestures(ctl, store, plainClick),
  );

  // --- the image on screen -------------------------------------------------
  // `shown` is what the stage draws. A new `current` replaces it only once its
  // stage copy is loaded AND decoded, then in one frame: the old image stays up
  // until that moment (a spinner joins it if the wait is long), so ← / → never
  // passes through a blank or a fade. Rapid presses keep moving `index` (the
  // counter follows at once); whichever image is current when a decode lands
  // is the one shown.
  const [decoded] = useState(() => createDecodedCache(DECODED_MAX));
  const [shown, setShown] = useState<Shown>(() => {
    const natural = knownSize(current) ?? loadedSize(originOf?.(index) ?? null);
    return { ...stageCopy(current), natural, via: "open" };
  });
  const swapping = !sameImage(current, shown.image);
  const currentRef = useEventCallback(() => current);
  const [slowSwap, setSlowSwap] = useState<string | null>(null);
  useEffect(() => {
    if (!swapping) return;
    const image = currentRef();
    const copy = stageCopy(image);
    let live = true;
    const slow = later(() => setSlowSwap(image.src), SLOW_SWAP_MS);
    decoded.load(copy.url).then(
      (size) => {
        if (!live) return;
        // A copy's pixels are not the original's: its size comes from the caller.
        const natural = copy.url === image.src ? size : knownSize(image);
        setShown({ ...copy, natural, via: "swap" });
      },
      (err: unknown) => {
        if (!live) return;
        if (!isLoadFailure(err)) throw err;
        // Let the stage load the original itself: it shows the loading state,
        // then the image — or, if the original fails too, says so.
        setShown({
          image,
          url: image.src,
          edge: Infinity,
          natural: knownSize(image),
          via: "open",
        });
      },
    );
    return () => {
      live = false;
      cancel(slow);
    };
  }, [swapping, current.src, current.name, currentRef, decoded, later, cancel]);

  useLayoutEffect(() => {
    if (shown.via === "swap" && shown.natural) ctl.swapTo(shown.natural);
    else if (shown.via === "open") ctl.showImage(shown.natural);
    // "sharper": the same image at more pixels, nothing to re-fit.
  }, [ctl, shown]);

  // A zoom past the copy's pixels swaps in a larger one (or the original),
  // decoded first, in the same element box — so it sharpens, never flashes.
  const shownRef = useEventCallback(() => shown);
  useEffect(() => {
    let wanted: string | null = null;
    return store.subscribe(() => {
      const now = shownRef();
      const { natural, view } = store.getState();
      if (!natural || now.url === now.image.src) return;
      const need =
        Math.max(natural.width, natural.height) * view.scale * pixelRatio();
      if (need <= now.edge) return;
      const edge = need * SHARPEN_HEADROOM;
      const url = pickSrc(now.image, edge, true);
      if (url === now.url || url === wanted) return;
      wanted = url;
      decoded.load(url).then(
        () => {
          const latest = shownRef();
          if (wanted !== url || !sameImage(latest.image, now.image)) return;
          setShown({
            ...latest,
            url,
            edge: url === now.image.src ? Infinity : edge,
            via: "sharper",
          });
        },
        (err: unknown) => {
          // A larger copy that fails leaves the smaller one on screen.
          if (!isLoadFailure(err)) throw err;
        },
      );
    });
  }, [store, shownRef, decoded]);

  // The neighbours a step lands on next are decoded ahead: both sides, plus
  // one further in the direction of travel (the slideshow mostly moves on).
  const lastIndex = useRef(index);
  useEffect(() => {
    const dir = index >= lastIndex.current ? 1 : -1;
    lastIndex.current = index;
    const n = images.length;
    if (n < 2) return;
    const around = new Set([
      (index + 1) % n,
      (index - 1 + n) % n,
      (index + 2 * dir + 2 * n) % n,
    ]);
    around.delete(index);
    for (const i of around) {
      const image = images[i];
      if (!image) continue;
      decoded.load(stageCopy(image).url).catch((err: unknown) => {
        // A neighbour that fails is found out when it is stepped to.
        if (!isLoadFailure(err)) throw err;
      });
    }
  }, [index, images, decoded]);

  // The element writer: every store change that moves or shows the image is
  // written straight onto the <img>, animated only when the change asked to be.
  useLayoutEffect(() => {
    let last = store.getState();
    return store.subscribe((meta) => {
      const s = store.getState();
      const img = imgRef.current;
      const moved = s.view !== last.view;
      if (img && (moved || s.imageVisible !== last.imageVisible)) {
        writeImage(img, s, moved && readMeta(meta).animate);
      }
      last = s;
    });
  }, [store]);
  const setImg = useCallback(
    (el: HTMLImageElement | null) => {
      imgRef.current = el;
      if (el) writeImage(el, store.getState(), false);
    },
    [store],
  );

  // --- the thumbnail the image was lifted out of ---------------------------
  useLayoutEffect(() => {
    const el = originOf?.(index);
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return;
    const before = el.style.visibility;
    el.style.visibility = "hidden";
    return () => {
      el.style.visibility = before;
    };
  }, [originOf, index]);

  // --- stage size ----------------------------------------------------------
  const navigable = images.length > 1;
  useResizeObserver(
    stageRef,
    () => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      ctl.measure({ width: r.width, height: r.height }, navigable);
    },
    { deps: [navigable] },
  );
  const compact = ViewStore.useSelector(
    (s) => s.area !== null && s.area.width < COMPACT_BELOW,
    [],
  );

  // --- focus ---------------------------------------------------------------
  useLayoutEffect(() => {
    const root = rootRef.current;
    // Guarded so a re-run (StrictMode) does not record the viewer itself.
    if (!root?.contains(document.activeElement))
      previousFocus.current = document.activeElement;
    root?.focus({ preventScroll: true });
  }, []);

  // --- the controls' idle fade ---------------------------------------------
  const idleTimer = useRef<number | null>(null);
  const wake = useEventCallback(() => {
    cancel(idleTimer.current);
    idleTimer.current = null;
    ctl.setIdle(false);
    if (!ctl.isZoomed()) return;
    idleTimer.current = later(() => {
      idleTimer.current = null;
      if (
        store.getState().sheet ||
        rootRef.current?.querySelector(HOVERED_CHROME)
      )
        return;
      ctl.setIdle(true);
    }, IDLE_MS);
  });

  // --- first-open hint -----------------------------------------------------
  // Decided once per mount (read, never written, in render), so a StrictMode
  // effect re-run shows the hint again instead of finding the flag spent.
  const [firstOpen] = useState(() => !hintShown);
  useEffect(() => {
    if (!firstOpen) return;
    hintShown = true;
    ctl.setHint(true);
    const id = later(() => ctl.setHint(false), HINT_MS);
    return () => {
      cancel(id);
      ctl.setHint(false);
    };
  }, [firstOpen, ctl, later, cancel]);

  // --- wheel (non-passive, so it can keep the page from scrolling) ---------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      gestures.wheel(e, stage);
      wake();
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [gestures, wake]);

  // --- actions -------------------------------------------------------------
  const capabilities = imageCapabilities(
    shown.image.src,
    window.location.origin,
  );
  const statusTimer = useRef<number | null>(null);
  const feedback = useEventCallback((message: string) => {
    cancel(statusTimer.current);
    ctl.setStatus(message);
    announce(message);
    statusTimer.current = later(() => ctl.setStatus(null), STATUS_MS);
  });

  const copy = useEventCallback(async (): Promise<void> => {
    const img = imgRef.current;
    if (!img || !capabilities.copy || store.getState().natural === null) return;
    try {
      await copyImage(img, shown.image.src);
    } catch (err) {
      // The one refusal a user can cause: the browser denies clipboard access
      // (permission, or the page lost focus mid-copy). Anything else is a bug.
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        feedback("The browser didn't allow copying the image");
        return;
      }
      throw err;
    }
    feedback("Image copied");
  });
  const download = useEventCallback(() => {
    downloadImage(shown.image.src, shown.image.name);
    feedback(`Downloading ${shown.image.name}`);
  });

  // --- grid ----------------------------------------------------------------
  const gridRef = useRef<HTMLElement | null>(null);
  const moveInGrid = useEventCallback((move: GridMove) =>
    goTo(gridMove(index, move, columnsOf(gridRef.current), images.length)),
  );
  const openFromGrid = useEventCallback((i: number) => {
    goTo(i);
    ctl.setLayout("single");
    rootRef.current?.focus({ preventScroll: true });
  });

  // --- slideshow: the browser's full screen, on the viewer itself ----------
  const toggleSlideshow = useEventCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (!document.fullscreenEnabled) {
      feedback("Full screen isn't allowed here");
      return;
    }
    root.requestFullscreen().catch((err: unknown) => {
      // The one refusal a user can cause: the browser denies the request
      // (no user activation, or a frame without allowfullscreen).
      if (
        err instanceof TypeError ||
        (err instanceof DOMException && err.name === "NotAllowedError")
      ) {
        feedback("Full screen isn't allowed here");
        return;
      }
      throw err;
    });
  });
  // The browser owns leaving (Esc, a gesture): mirror its state, never assume.
  useEffect(() => {
    const sync = () =>
      ctl.setSlideshow(
        document.fullscreenElement !== null &&
          document.fullscreenElement === rootRef.current,
      );
    const root = rootRef.current;
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      if (root && document.fullscreenElement === root)
        void document.exitFullscreen();
    };
  }, [ctl]);

  // --- device-local preferences: the strip and the tile size ---------------
  // Written once a change settles (and on close), not on every tick of a
  // slider drag or a pinch.
  useEffect(() => {
    let last = store.getState();
    let timer: number | null = null;
    const save = () => {
      timer = null;
      writeViewPrefs({ strip: last.strip, tile: Math.round(last.tile) });
    };
    const unsubscribe = store.subscribe(() => {
      const s = store.getState();
      if (s.strip === last.strip && s.tile === last.tile) return;
      last = s;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(save, PREFS_SETTLE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) {
        window.clearTimeout(timer);
        save();
      }
    };
  }, [store]);

  const run = useEventCallback((action: ViewerAction) => {
    const grid = store.getState().layout === "grid";
    switch (action) {
      case "close":
        if (store.getState().sheet) ctl.setSheet(false);
        else requestClose();
        return;
      case "zoom-in":
        return grid ? ctl.stepTile(1) : ctl.step(1);
      case "zoom-out":
        return grid ? ctl.stepTile(-1) : ctl.step(-1);
      case "fit":
        return ctl.toFit(true);
      case "actual-size":
        return ctl.actualSize();
      case "previous":
        return grid ? moveInGrid("left") : go(-1);
      case "next":
        return grid ? moveInGrid("right") : go(1);
      case "row-up":
        return moveInGrid("up");
      case "row-down":
        return moveInGrid("down");
      case "open-selected":
        return openFromGrid(index);
      case "toggle-strip":
        if (grid) {
          ctl.setLayout("single");
          ctl.setStrip(true);
        } else ctl.setStrip(!store.getState().strip);
        return;
      case "toggle-grid":
        return ctl.setLayout(grid ? "single" : "grid");
      case "slideshow":
        return toggleSlideshow();
      case "copy":
        void copy();
        return;
      case "shortcuts":
        return ctl.setSheet(!store.getState().sheet);
    }
  });

  // The global shortcut manager listens on `window`; this portal lives in
  // <body>, so stopping every keydown here keeps app shortcuts (Esc leaving
  // solo mode, ⌘K…) from also firing while the viewer has focus.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (store.getState().phase === "closing") return;
    // Commit the controls before acting, so a Tab or a key zoom lands on
    // visible, focusable buttons rather than faded ones.
    if (store.getState().idle) flushSync(() => ctl.setIdle(false));
    if (e.key === "Tab") {
      if (rootRef.current) cycleFocus(e, rootRef.current);
    } else if (!ownedByFocusedControl(e)) {
      const action = matchViewerKey(e, modeOf(store.getState()));
      if (action) {
        e.preventDefault();
        run(action);
      }
    }
    // After the action, so a key zoom starts the idle countdown it caused.
    wake();
  };

  // --- render --------------------------------------------------------------
  const phase = ViewStore.useSelector((s) => s.phase, []);
  const idle = ViewStore.useSelector((s) => s.idle, []);
  const zoomed = ViewStore.useSelector(
    (s) =>
      s.natural !== null &&
      s.area !== null &&
      isZoomed(s.view, s.natural, s.area),
    [],
  );
  const dragging = ViewStore.useSelector((s) => s.dragging, []);
  const natural = ViewStore.useSelector((s) => s.natural, []);
  const failed = ViewStore.useSelector((s) => s.failed, []);
  const layout = ViewStore.useSelector((s) => s.layout, []);
  const slideshow = ViewStore.useSelector((s) => s.slideshow, []);
  const strip = ViewStore.useSelector((s) => s.strip, []);
  const area = ViewStore.useSelector((s) => s.area, []);
  const single = layout === "single";
  const stripShown = strip && single && !slideshow && navigable;

  // A view change can unmount the focused control (a strip thumbnail, a grid
  // tile). Focus would fall to <body>, outside the viewer's key handler — so
  // take it back to the viewer root.
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement))
      root.focus({ preventScroll: true });
  }, [layout, stripShown, slideshow]);

  return (
    <ViewportOverlay
      ref={rootRef}
      layer="popover"
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${current.name}`}
      tabIndex={-1}
      className="outline-none"
      onKeyDown={onKeyDown}
      onPointerMove={wake}
    >
      {/* Image viewers are dark by convention, whatever the app's theme: the
          photo is the content and the chrome should recede. There is no scoped
          color-mode primitive (per-scope dark is deferred — see the theme
          skill), so this box opts into the theme's own `.dark` token block by
          class: the global dark palette ThemeInjector emits is selected on
          `.dark`, which re-declares every token on this element, and `dark:`
          variants key on a `.dark` ancestor. It sits INSIDE the portal root
          (which may carry an app's `data-theme-scope` block at equal
          specificity) so it wins by being the nearer declaration. */}
      <Layer
        className="dark group/viewer text-foreground"
        data-phase={phase}
        data-chrome={phase !== "open" || idle || slideshow ? "hidden" : "shown"}
        data-zoomed={zoomed}
        data-dragging={dragging}
        data-slideshow={slideshow}
      >
        {/* The slideshow is the image alone on black, edge to edge. */}
        <Layer
          decorative
          className="bg-background/95 opacity-0 transition-opacity duration-300 group-data-[phase=open]/viewer:opacity-100 group-data-[slideshow=true]/viewer:bg-black"
        />
        <Layer
          ref={stageRef}
          // Kept laid out under the grid (invisible, not removed), so the stage
          // stays measured and the image is where it was when the grid closes.
          className={cn(
            "touch-none select-none group-data-[zoomed=true]/viewer:cursor-grab group-data-[dragging=true]/viewer:cursor-grabbing",
            "group-data-[slideshow=true]/viewer:cursor-none",
            !single && "invisible",
          )}
          onPointerDown={(e) =>
            gestures.pointerDown(e.nativeEvent, e.currentTarget, imgRef.current)
          }
          onPointerMove={(e) =>
            gestures.pointerMove(e.nativeEvent, e.currentTarget)
          }
          onPointerUp={(e) => {
            gestures.pointerUp(e.nativeEvent);
            wake();
          }}
          onPointerCancel={(e) => gestures.pointerCancel(e.nativeEvent)}
        >
          {((natural === null && !failed) ||
            (swapping && slowSwap === current.src)) && (
            <Center className="size-full">
              <Loading variant="spinner" />
            </Center>
          )}
          {failed && (
            <Center className="size-full">
              <Placeholder>Couldn&apos;t load this image.</Placeholder>
            </Center>
          )}
          <img
            ref={setImg}
            data-viewer-stage
            src={shown.url}
            alt={shown.image.alt ?? shown.image.name}
            draggable={false}
            onLoad={(e) =>
              // A copy's own pixels are fewer: the original's size is the truth.
              ctl.loaded(
                shown.url !== shown.image.src && shown.natural
                  ? shown.natural
                  : {
                      width: e.currentTarget.naturalWidth,
                      height: e.currentTarget.naturalHeight,
                    },
              )
            }
            onError={() => {
              if (shown.url === shown.image.src) {
                ctl.failedToLoad();
                return;
              }
              // A copy the server could not make: the original instead.
              setShown({
                ...shown,
                url: shown.image.src,
                edge: Infinity,
                via: "open",
              });
            }}
            className={cn(
              placedClasses(),
              "max-w-none origin-top-left cursor-zoom-out shadow-2xl will-change-transform",
              "group-data-[zoomed=true]/viewer:cursor-grab group-data-[dragging=true]/viewer:cursor-grabbing",
              "group-data-[slideshow=true]/viewer:cursor-none group-data-[slideshow=true]/viewer:shadow-none",
            )}
            style={{
              ...placedStyle({ start: 0 }, { start: 0 }),
              ...(natural
                ? { width: natural.width, height: natural.height }
                : {}),
            }}
          />
        </Layer>
        {layout === "grid" && (
          <ImageGrid
            images={images}
            index={index}
            area={area}
            gridRef={gridRef}
            ctl={ctl}
            onSelect={goTo}
            onOpen={openFromGrid}
          />
        )}
        {stripShown && (
          <ThumbnailStrip images={images} index={index} onSelect={goTo} />
        )}
        <ControlSizeProvider size="md">
          <TopBar
            image={shown.image}
            index={index}
            count={images.length}
            capabilities={capabilities}
            compact={compact}
            onCopy={copy}
            onDownload={download}
            onSlideshow={toggleSlideshow}
            onClose={requestClose}
          />
          {single && (
            <NavArrows
              index={index}
              count={images.length}
              lifted={stripShown}
              onPrevious={() => go(-1)}
              onNext={() => go(1)}
            />
          )}
          <BottomBar ctl={ctl} count={images.length} />
          {!compact && single && (
            <Minimap image={shown.image} ctl={ctl} lifted={stripShown} />
          )}
        </ControlSizeProvider>
      </Layer>
    </ViewportOverlay>
  );
}
