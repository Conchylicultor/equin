import type { RENDER_PROFILER_GLOBAL } from "./constants";
import type { ProfilerReport, ProfilerStartOptions } from "./types";

/**
 * The window-level imperative API render-profiler's `Core.Root` installer
 * exposes, and the window it lives on. In `core/` because it has two parties:
 * the web module that INSTALLS it and the headless e2e drivers that CALL it,
 * and `e2e` may import `core` but never `web`.
 *
 * A type both sides CAST `window` to, not a `Window` augmentation: a global
 * declaration makes every edit to the file holding it re-check the whole repo
 * (`type-check/no-global-declaration-in-source`).
 */
export interface RenderProfilerGlobal {
  start: (opts?: ProfilerStartOptions) => void;
  stop: () => void;
  getReport: () => ProfilerReport;
  isRunning: () => boolean;
}

export type RenderProfilerWindow = Window & {
  [RENDER_PROFILER_GLOBAL]?: RenderProfilerGlobal;
};
