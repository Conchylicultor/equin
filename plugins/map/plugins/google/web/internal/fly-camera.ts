import { flyPath, type CameraView } from "@plugins/map/core";

/** Ease in and out, so a flight starts and lands softly. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Flies the map to `target` along the core's smooth path, one `moveCamera`
 * per animation frame. Google zooms raster maps by whole levels only, so
 * fractional zoom is switched on for the flight and back off once it lands
 * (on a whole zoom — `viewFor` picks one). Any press, wheel or drag of the
 * user's stops it where it is: the camera is theirs again. Returns the stop.
 */
export function flyCamera(
  map: google.maps.Map,
  target: CameraView,
): () => void {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const div = map.getDiv();
  if (center === undefined || zoom === undefined) {
    // Not laid out yet: nothing to fly from.
    map.moveCamera(target);
    return () => {};
  }
  const path = flyPath({ center: center.toJSON(), zoom }, target, {
    width: div.clientWidth,
    height: div.clientHeight,
  });
  if (path.durationMs === 0) {
    map.moveCamera(target);
    return () => {};
  }

  map.setOptions({ isFractionalZoomEnabled: true });
  let frame = 0;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    div.removeEventListener("pointerdown", stop, true);
    div.removeEventListener("wheel", stop, true);
    map.setOptions({ isFractionalZoomEnabled: false });
  };
  div.addEventListener("pointerdown", stop, true);
  div.addEventListener("wheel", stop, { capture: true, passive: true });

  const start = performance.now();
  const step = (now: number) => {
    if (done) return;
    const t = Math.min(1, (now - start) / path.durationMs);
    map.moveCamera(path.at(easeInOutCubic(t)));
    if (t < 1) frame = requestAnimationFrame(step);
    else stop();
  };
  frame = requestAnimationFrame(step);
  return stop;
}
