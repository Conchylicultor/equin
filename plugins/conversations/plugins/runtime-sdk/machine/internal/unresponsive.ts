// How long each agent has gone without answering `hello`. One missed reply is
// not news: under host duress (2026-10-30, load 180 on 18 CPUs) a healthy agent
// misses the 10 s bound, and the reconciler already marks its conversation
// unverified for that pass. An agent that misses every probe for minutes is
// wedged — that is the one worth a report, once per stretch.

export interface UnresponsiveStretch {
  /** When the stretch's first missed reply was seen. */
  since: number;
  /** The latest miss's detail (the socket client's message). */
  detail: string;
}

export interface UnresponsiveTracker {
  /**
   * Record one probe of `id`: `detail` when it did not answer, null when it
   * did (or is gone). Returns the stretch the first time it reaches the
   * threshold, null otherwise.
   */
  observe(
    id: string,
    now: number,
    detail: string | null,
  ): UnresponsiveStretch | null;
  /** Forget every agent not in `ids` (they are no longer running here). */
  retain(ids: readonly string[]): void;
}

export function createUnresponsiveTracker(
  thresholdMs: number,
): UnresponsiveTracker {
  const stretches = new Map<
    string,
    UnresponsiveStretch & { reported: boolean }
  >();
  return {
    observe(id, now, detail) {
      if (detail === null) {
        stretches.delete(id);
        return null;
      }
      const stretch = stretches.get(id) ?? {
        since: now,
        detail,
        reported: false,
      };
      stretch.detail = detail;
      stretches.set(id, stretch);
      if (stretch.reported || now - stretch.since < thresholdMs) return null;
      stretch.reported = true;
      return { since: stretch.since, detail };
    },
    retain(ids) {
      const keep = new Set(ids);
      for (const id of stretches.keys())
        if (!keep.has(id)) stretches.delete(id);
    },
  };
}
