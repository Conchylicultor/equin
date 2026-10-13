import { serveValue } from "@plugins/network/plugins/live/server";
import {
  auditUserConfigOrphans,
  configRegistryReady,
  configWatcherArmed,
  onConfigDirChange,
} from "@plugins/config_v2/server";
import { configOrphansReport } from "../../shared/report";

/**
 * The orphan audit as a live value. Pure presentation seam: config_v2 owns the
 * config-dir layout and the audit logic; this surfaces its report.
 *
 * Its answer is a function of two inputs, each with its signal:
 * - the `.jsonc` files under the user-layer config dir — config_v2's
 *   `onConfigDirChange`, heard for as long as the report is read. Its watcher
 *   arms after the registry answers reads, so the subscription re-reads once
 *   it is live (`configWatcherArmed`): a write in between is not missed;
 * - the live descriptor registry — fixed once `initRegistry` has run (the
 *   loader awaits it, so an early read never audits an empty registry and
 *   reports every file as orphaned).
 *
 * Throttled: a config write lands as a watcher batch, and each recompute walks
 * the whole config dir.
 */
export const configOrphansReportServed = serveValue(configOrphansReport, {
  source: "external",
  changes: "notified",
  throttleMs: 1000,
  loader: async () => {
    await configRegistryReady();
    return auditUserConfigOrphans();
  },
  whileSubscribed: async (_params, notify) => {
    const off = onConfigDirChange(() => notify());
    try {
      await configWatcherArmed();
    } catch (err) {
      off();
      throw err;
    }
    notify();
    return off;
  },
});
