/**
 * The vector map's wheel zoom, in place of Google's. Google exposes no wheel
 * speed, and its vector map turns a scroll burst (a trackpad's momentum
 * especially) into several levels at once. Here a scroll moves the zoom by a
 * fixed number of levels per pixel, scaled by the user's speed, and glides
 * there; a pinch follows the fingers exactly. The point under the cursor stays
 * under the cursor.
 */

/** Scroll pixels per zoom level at speed 1: a 100 px mouse notch is 0.4 level. */
const SCROLL_PX_PER_LEVEL = 250;
/**
 * A trackpad pinch arrives as a ctrl+wheel whose `deltaY` is
 * `-100 · ln(scale)` (Chrome, Safari, Firefox): this many pixels double the
 * scale, so the map tracks the fingers 1:1.
 */
const PINCH_PX_PER_LEVEL = 100 * Math.LN2;
/**
 * Most one scroll event moves, in levels: a fast-spun or accelerated wheel
 * reports one huge delta, which would otherwise jump several levels at once.
 */
const MAX_SCROLL_LEVELS = 1;
/** Line-mode deltas (Firefox's mouse wheel) in pixels. */
const LINE_PX = 16;
/** Time constant of the glide toward the target zoom. */
const GLIDE_MS = 90;
/** Close enough to the target to land on it. */
const LANDED = 0.001;

/** The zoom change, in levels, one wheel event asks for (positive = in). */
export function wheelZoomLevels(
  e: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">,
  speed: number,
  pagePx: number,
): number {
  const px =
    e.deltaMode === 1
      ? e.deltaY * LINE_PX
      : e.deltaMode === 2
        ? e.deltaY * pagePx
        : e.deltaY;
  if (e.ctrlKey) return -px / PINCH_PX_PER_LEVEL;
  const levels = (-px / SCROLL_PX_PER_LEVEL) * speed;
  return Math.max(-MAX_SCROLL_LEVELS, Math.min(MAX_SCROLL_LEVELS, levels));
}

/**
 * Takes the wheel over `map` (whose own `scrollwheel` must be off). `speed`
 * is read on every event, so a changed setting applies at once. Any press
 * stops a glide where it is: the camera is the user's drag's. Returns the
 * detach.
 */
export function attachWheelZoom(
  map: google.maps.Map,
  speed: () => number,
): () => void {
  const div = map.getDiv();
  /** The zoom the glide is heading to, and where it is now; null at rest. */
  let glide: { target: number; current: number } | null = null;
  /** The world point under the cursor, and the cursor's offset from centre. */
  let anchor: { world: google.maps.Point; dx: number; dy: number } | null =
    null;
  let frame = 0;
  let last = 0;

  const bounds = () => ({
    min: (map.get("minZoom") as number | null | undefined) ?? 0,
    max: (map.get("maxZoom") as number | null | undefined) ?? 22,
  });

  const stop = () => {
    cancelAnimationFrame(frame);
    glide = null;
  };

  const apply = (zoom: number) => {
    const projection = map.getProjection();
    if (anchor === null || projection == null) {
      map.moveCamera({ zoom });
      return;
    }
    const scale = 2 ** zoom;
    const center = projection.fromPointToLatLng(
      new google.maps.Point(
        anchor.world.x - anchor.dx / scale,
        anchor.world.y - anchor.dy / scale,
      ),
    );
    map.moveCamera(center === null ? { zoom } : { center, zoom });
  };

  const step = (now: number) => {
    if (glide === null) return;
    // A frame's timestamp is its start, which can precede the event that
    // asked for it: never step backwards.
    const dt = Math.max(0, Math.min(now - last, 100));
    last = now;
    const gap = glide.target - glide.current;
    glide.current =
      Math.abs(gap) < LANDED
        ? glide.target
        : glide.current + gap * (1 - Math.exp(-dt / GLIDE_MS));
    apply(glide.current);
    // Google clamped the zoom (the world already fills the view, or the
    // deepest level): stop there rather than push against it.
    const shown = map.getZoom();
    if (shown !== undefined && Math.abs(shown - glide.current) > LANDED) {
      stop();
      return;
    }
    if (glide.current === glide.target) glide = null;
    else frame = requestAnimationFrame(step);
  };

  const onWheel = (e: WheelEvent) => {
    // The page never scrolls (or browser-zooms) under the map.
    e.preventDefault();
    const zoom = map.getZoom();
    const center = map.getCenter();
    const projection = map.getProjection();
    if (zoom === undefined || center === undefined || projection == null) {
      return;
    }
    const levels = wheelZoomLevels(e, speed(), div.clientHeight);
    if (levels === 0) return;

    // Re-anchor on every event, from the camera as it is now: the cursor may
    // have moved since the last one.
    const rect = div.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    const c = projection.fromLatLngToPoint(center);
    if (c !== null) {
      const scale = 2 ** zoom;
      anchor = {
        world: new google.maps.Point(c.x + dx / scale, c.y + dy / scale),
        dx,
        dy,
      };
    }

    const { min, max } = bounds();
    const from = glide?.target ?? zoom;
    const target = Math.min(max, Math.max(min, from + levels));
    if (e.ctrlKey) {
      // A pinch is already continuous: follow it, no glide behind the fingers.
      stop();
      apply(target);
      return;
    }
    if (glide === null) {
      glide = { target, current: zoom };
      last = performance.now();
      frame = requestAnimationFrame(step);
    } else {
      glide.target = target;
    }
  };

  div.addEventListener("wheel", onWheel, { passive: false });
  div.addEventListener("pointerdown", stop, true);
  return () => {
    stop();
    div.removeEventListener("wheel", onWheel);
    div.removeEventListener("pointerdown", stop, true);
  };
}
