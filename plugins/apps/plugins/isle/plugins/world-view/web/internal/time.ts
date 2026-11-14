import { useEffect, useState } from "react";
import type { TimeOfDay } from "@plugins/apps/plugins/isle/plugins/renderer/web";
import { dayPhaseAt } from "../../core";

/**
 * The island's time of day: the override, or the clock's — read from `Date`,
 * then re-read once at the next phase boundary (one one-shot timeout, re-armed
 * at each boundary; never an interval).
 */
export function useTimeOfDay(override: TimeOfDay | "auto"): TimeOfDay {
  const [clock, setClock] = useState(() => dayPhaseAt(new Date()).phase);
  useEffect(() => {
    if (override !== "auto") return;
    let timer = 0;
    const arm = () => {
      const now = new Date();
      const p = dayPhaseAt(now);
      setClock(p.phase);
      timer = window.setTimeout(
        arm,
        Math.max(1000, p.next.getTime() - now.getTime() + 500),
      );
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [override]);
  return override === "auto" ? clock : override;
}
