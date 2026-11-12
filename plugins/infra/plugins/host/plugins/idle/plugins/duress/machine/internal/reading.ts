import {
  FRESHNESS_LEASE_MS,
  type DuressReading,
} from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import type { IdleBlockerReading } from "@plugins/infra/plugins/host/plugins/idle/core";

/**
 * What the duress latch says about idleness, read at `now`. A fresh latch is
 * busy, and asks to be read again when its lease could lapse: the sentinel
 * refreshes it every tick while tripped, so a read at `now` proves it fresh
 * until at most `now + FRESHNESS_LEASE_MS` — and a lapse (a sentinel that
 * died mid-episode) emits no event.
 */
export function duressBlockerReading(
  reading: DuressReading | null,
  now: number,
): IdleBlockerReading {
  if (reading?.fresh !== true)
    return { busy: false, label: "no duress", recheckAt: null };
  return {
    busy: true,
    label: `under duress: ${reading.latch.reason}`,
    recheckAt: now + FRESHNESS_LEASE_MS,
  };
}
