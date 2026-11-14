import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/central";
import { listProviders } from "./registry";
import { getAccount } from "./token-store";
import { getAccessTokenInternal } from "./token-access";

const TICK_INTERVAL_MS = 60_000;
const REFRESH_LEAD_MS = 5 * 60 * 1000;

// Central has no job queue, so this periodic refresh is a timer — listed in
// Background activity (central half).
export const authRefreshTimer = defineTimer({
  name: "auth.refresh",
  description:
    "Refreshes connected OAuth accounts' access tokens shortly before they expire, so apps never hit an expired token.",
  everyMs: TICK_INTERVAL_MS,
  unref: true,
  run: tick,
});

export function startRefreshLoop(): void {
  authRefreshTimer.start();
}

export function stopRefreshLoop(): void {
  authRefreshTimer.stop();
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const provider of listProviders()) {
    if (provider.kind !== "oauth2") continue;
    const account = getAccount(provider.id, "primary");
    if (!account || account.needsReconsent || !account.refreshToken) continue;
    const expiresAt = account.expiresAt ?? 0;
    if (expiresAt > now + REFRESH_LEAD_MS) continue;
    // getAccessTokenInternal owns the refresh path + per-account mutex and
    // answers a failure as a result (persisted on the account as
    // lastRefreshError), never a throw; anything it does throw is a bug, owned
    // by the timer (recorded as a failed run).
    await getAccessTokenInternal({ providerId: provider.id });
  }
}
