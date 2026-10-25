import "./loading-bar.css";

/**
 * Thin top progress bar, shown while a page is loading: a 2px primary bar that
 * eases out to most of the width (a load has no real progress to report, so it
 * slows as it goes, like Chrome's). Rendered inside an Overlay `above` layer
 * (full-bleed, click-through); the bar sits at the top of that layer's normal
 * block flow.
 */
export function LoadingBar() {
  return <div className="browser-loading-bar h-0.5 bg-primary" />;
}
