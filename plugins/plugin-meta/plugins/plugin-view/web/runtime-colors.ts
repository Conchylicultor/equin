import type { RuntimeFolder } from "@plugins/framework/plugins/plugin-id/core";

/**
 * The runtime a public-API symbol is exported from. Derived from the single
 * source of truth (RUNTIME_FOLDERS in plugin-id/core) rather than re-listed
 * here — a hand-copied union silently drifts the moment a runtime is added,
 * and RUNTIME_COLORS below then has no entry for it.
 */
export type ExportRuntime = RuntimeFolder;

/**
 * Canonical categorical-palette classes for each plugin runtime.
 * Pill-style (bg tint + text color) — used by both the runtimes pill section
 * and the public-api runtime-group label.
 *
 * `Record<ExportRuntime, …>` is exhaustive by construction: adding a runtime
 * folder makes this object a type error until it gets a color.
 */
export const RUNTIME_COLORS: Record<ExportRuntime, string> = {
  web: "bg-categorical-1/10 text-categorical-1",
  server: "bg-categorical-2/10 text-categorical-2",
  // The desktop-only half of the same backend: it shares server's hue (the
  // palette's ten hues are all taken, and the two halves boot as one graph).
  machine: "bg-categorical-2/10 text-categorical-2",
  central: "bg-categorical-5/10 text-categorical-5",
  core: "bg-categorical-3/10 text-categorical-3",
  shared: "bg-categorical-9/10 text-categorical-9",
  e2e: "bg-categorical-7/10 text-categorical-7",
  provision: "bg-categorical-6/10 text-categorical-6",
  "data-dirs": "bg-categorical-4/10 text-categorical-4",
  cli: "bg-categorical-8/10 text-categorical-8",
  deps: "bg-categorical-10/10 text-categorical-10",
};
