/**
 * Whether this document is an installed app's own window: the helper injects
 * `window.equinWindow` there before any page script runs (main frame, the
 * window's origin only — `rust/src/window_bridge.js`), so its presence is
 * known synchronously and never changes while the page lives.
 */
export function inAppWindow(): boolean {
  return (window as { equinWindow?: unknown }).equinWindow !== undefined;
}
