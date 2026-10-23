/**
 * `@plugins/apps/plugins/sonata/plugins/covers/core` — Sonata song covers drawn
 * from the real song, as SVG strings: pure, framework-free, host-agnostic.
 */

export type { CoverWindow } from "./internal/window";
export { busiestWindow } from "./internal/window";
export { renderRollCover } from "./internal/roll-cover";
export { renderStaffCover } from "./internal/staff-cover";
export { COVER_RENDER_VERSION } from "./internal/version";
