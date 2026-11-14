import { readAwakeClock } from "@plugins/packages/plugins/sleep-clock/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";
import { humanDuration } from "@plugins/auth/core";
import {
  createRefreshFailureWatch,
  type RefreshFailure,
} from "./refresh-failures";

// The impure half of the refresh-failure watch: this process's clocks, and the
// report outbox (central has no reports table; main drains the outbox and
// records the `auth-refresh-failed` kind auth/server registers). A failed
// refresh otherwise shows only as lastRefreshError in Settings → Accounts.
//
// The awake clock is read straight from packages/sleep-clock: machine-sleep's
// awake-time helpers live in its server/ half, which central cannot import.
const watch = createRefreshFailureWatch({
  nowMs: () => Date.now(),
  awakeMs: () => {
    const r = readAwakeClock();
    return r.supported ? r.awakeMs : null;
  },
});

export function refreshSucceeded(providerId: string, accountId: string): void {
  watch.succeeded(providerId, accountId);
}

/** Tell the watch of a failed refresh, and file the report it says is due. */
export async function reportRefreshFailure(f: RefreshFailure): Promise<void> {
  const payload = watch.failed(f);
  if (payload === null) return;
  const message =
    payload.kind === "permanent"
      ? `${payload.providerName} refused the token refresh — the account needs reconnecting: ${payload.error}`
      : `${payload.providerName} token refresh failing for ${humanDuration(payload.failingMs)} of awake time: ${payload.error}`;
  console.warn(`[auth] ${message}`);
  const result = await fileReportFromProcess({
    kind: "auth-refresh-failed",
    message,
    data: payload,
  });
  if (result.outcome !== "written")
    console.error(
      `[auth] could not file the refresh-failure report (${result.outcome}): ${message}`,
    );
}
