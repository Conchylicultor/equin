import {
  TRANSIENT_REFRESH_REPORT_AFTER_MS,
  type AuthRefreshFailedPayload,
  type RefreshFailureKind,
} from "@plugins/auth/core";

/** One failed refresh, as the watch is told of it. */
export interface RefreshFailure {
  providerId: string;
  providerName: string;
  accountId: string;
  kind: RefreshFailureKind;
  error: string;
  hint?: string;
}

/** The clocks the watch measures a run of failures on (injected for tests). */
export interface RefreshFailureClock {
  nowMs(): number;
  /** A clock that stops while the machine sleeps; null where it cannot be read. */
  awakeMs(): number | null;
}

interface Run {
  sinceMs: number;
  /** The awake clock at the first failure; null when it could not be read. */
  sinceAwakeMs: number | null;
  attempts: number;
  reported: boolean;
}

export interface RefreshFailureWatch {
  /** The account's refresh succeeded: its run of failures, if any, is over. */
  succeeded(providerId: string, accountId: string): void;
  /** A refresh failed: the report to file now, or null when it is not one (yet). */
  failed(f: RefreshFailure): AuthRefreshFailedPayload | null;
}

/**
 * Which failed refreshes are worth a report. A permanent failure always is —
 * the account then needs reconsent and is not refreshed again until the user
 * reconnects, so it happens once per grant. A transient one is, once per run
 * of failures, when the run has lasted TRANSIENT_REFRESH_REPORT_AFTER_MS of
 * AWAKE time: a laptop whose DNS is not back for a minute after each wake is a
 * blip, an hour of dark-wake naps spends almost none of the bound. The engine's
 * fingerprint (provider, account, kind) folds the runs into one row.
 */
export function createRefreshFailureWatch(
  clock: RefreshFailureClock,
): RefreshFailureWatch {
  const runs = new Map<string, Run>();
  const keyOf = (providerId: string, accountId: string): string =>
    `${providerId}::${accountId}`;
  return {
    succeeded(providerId, accountId) {
      runs.delete(keyOf(providerId, accountId));
    },
    failed(f) {
      const key = keyOf(f.providerId, f.accountId);
      const now = clock.nowMs();
      const awake = clock.awakeMs();
      const base = {
        providerId: f.providerId,
        providerName: f.providerName,
        accountId: f.accountId,
        kind: f.kind,
        error: f.error,
        ...(f.hint === undefined ? {} : { hint: f.hint }),
      };
      if (f.kind === "permanent") {
        const run = runs.get(key);
        runs.delete(key);
        return {
          ...base,
          sinceMs: run?.sinceMs ?? now,
          failingMs: run ? failingMs(run, now, awake) : 0,
          attempts: (run?.attempts ?? 0) + 1,
        };
      }
      let run = runs.get(key);
      if (!run) {
        run = {
          sinceMs: now,
          sinceAwakeMs: awake,
          attempts: 0,
          reported: false,
        };
        runs.set(key, run);
      }
      run.attempts += 1;
      const failing = failingMs(run, now, awake);
      if (run.reported || failing < TRANSIENT_REFRESH_REPORT_AFTER_MS)
        return null;
      run.reported = true;
      return {
        ...base,
        sinceMs: run.sinceMs,
        failingMs: failing,
        attempts: run.attempts,
      };
    },
  };
}

/** Awake time since the run began; wall time where the awake clock is unreadable. */
function failingMs(run: Run, nowMs: number, awakeMs: number | null): number {
  if (run.sinceAwakeMs !== null && awakeMs !== null)
    return awakeMs - run.sinceAwakeMs;
  return nowMs - run.sinceMs;
}
