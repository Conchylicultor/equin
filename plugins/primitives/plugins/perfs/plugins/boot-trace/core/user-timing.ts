// The User Timing spelling of the boot trace. Every recorded span / instant is
// mirrored into the browser's performance timeline under this prefix, so a
// reader outside the app bundle (a Playwright script's `page.evaluate`) reads
// the trace with `performance.getEntriesByType("measure" | "mark")` and no
// window global. Lives in core so such a reader can import the name it filters
// on.

/** Prefix of every boot User Timing entry: `boot:<span id>`. */
export const BOOT_TIMING_PREFIX = "boot:";

/** The `detail` every boot User Timing entry carries. */
export interface BootTimingDetail {
  phase: string;
  label: string;
  workMs?: number;
  detail?: string;
}

/**
 * Prefix of the per-plugin load measures: `boot-plugin:<pluginPath>`, one per
 * plugin module the boot sequence imports. User Timing only — never a span in
 * the store, so the boot-profile Gantt and persisted traces stay one row per
 * phase, not one per plugin.
 */
export const BOOT_PLUGIN_TIMING_PREFIX = "boot-plugin:";

/** The `detail` a per-plugin load measure carries. */
export interface BootPluginLoadDetail {
  /** Which load tier imported it: the eager tier, the active app's priority batch, or the rest of the deferred tier. */
  tier: "eager" | "priority" | "deferred";
  ok: boolean;
}
