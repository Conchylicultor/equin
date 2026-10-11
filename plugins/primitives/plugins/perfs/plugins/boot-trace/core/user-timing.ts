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
