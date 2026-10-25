/** One sliding window: at most `max` messages per `ms`. */
export interface RateWindow {
  ms: number;
  max: number;
}

const MINUTE = 60_000;

/**
 * Per visitor (`ip_hash`): 3 messages in any 10 minutes, 10 in any day. Every
 * stored message counts, spam included — a bot hammering the form fills its
 * own window, not the table.
 */
export const SITE_MESSAGE_RATE_WINDOWS: readonly RateWindow[] = [
  { ms: 10 * MINUTE, max: 3 },
  { ms: 24 * 60 * MINUTE, max: 10 },
];

/** The longest window: how far back the limiter reads. */
export const RATE_LOOKBACK_MS = Math.max(
  ...SITE_MESSAGE_RATE_WINDOWS.map((w) => w.ms),
);

export type RateDecision = { ok: true } | { ok: false; retryAfterS: number };

/**
 * May one more message arrive at `now`, given when this visitor's earlier
 * ones did? Over a window, the wait is until enough of its oldest messages
 * age out of it — the longest wait across the windows that are full.
 */
export function rateDecision(
  prior: readonly Date[],
  now: Date,
  windows: readonly RateWindow[] = SITE_MESSAGE_RATE_WINDOWS,
): RateDecision {
  let waitMs = 0;
  for (const w of windows) {
    const inWindow = prior
      .map((d) => d.getTime())
      .filter((t) => t > now.getTime() - w.ms)
      .sort((a, b) => a - b);
    if (inWindow.length < w.max) continue;
    // The (n - max + 1)-th oldest must leave the window for one slot to open.
    const freeing = inWindow[inWindow.length - w.max]!;
    waitMs = Math.max(waitMs, freeing + w.ms - now.getTime());
  }
  return waitMs === 0
    ? { ok: true }
    : { ok: false, retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)) };
}
