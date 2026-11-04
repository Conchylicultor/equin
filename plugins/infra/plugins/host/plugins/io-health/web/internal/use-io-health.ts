import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { hostIoHealth } from "../../core";
import { ioHealthVerdict } from "./io-health-verdict";

/**
 * The health report's Disk I/O row. One subscription to a small pushed value.
 * Time moves the verdict on its own (the newest tick goes stale when the
 * monitor stops), so `now` is state refreshed by ONE timer scheduled to that
 * instant — the database row's pattern; every new tick reschedules it.
 */
export function useIoHealth(): HealthStatus {
  const result = useLive(hostIoHealth);
  const [now, setNow] = useState(() => Date.now());
  const verdict = ioHealthVerdict(result, now);
  const nextChangeAt = verdict.nextChangeAt;

  useEffect(() => {
    if (nextChangeAt === null) return;
    const id = setTimeout(
      // Never step `now` short of the instant waited for, or the verdict and
      // this effect's dep stay put with no timer left.
      () => setNow(Math.max(Date.now(), nextChangeAt)),
      Math.max(0, nextChangeAt - Date.now()),
    );
    return () => clearTimeout(id);
  }, [nextChangeAt]);

  return verdict.status;
}
