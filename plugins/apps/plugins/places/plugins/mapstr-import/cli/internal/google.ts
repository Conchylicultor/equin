import { getMapsKey } from "@plugins/integrations/plugins/google-maps/server";
import { PlacesApiError } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/** The stored Places key, or a loud error saying where to set it up. */
export async function requireMapsKey(): Promise<string> {
  const key = await getMapsKey();
  if (!key.ok) {
    throw new Error(
      "No Google Maps (Places) key is configured — set it up in Settings → Accounts → Google Maps",
    );
  }
  return key.key;
}

// Google's per-minute request quotas (Text Search hits it after ~300 calls) are
// a 429 RESOURCE_EXHAUSTED: wait out the minute and retry the same call. A 429
// that outlasts a few minutes, or any other error, still fails the run.
const QUOTA_WAIT_MS = 60_000;
const MAX_QUOTA_WAITS = 5;

export async function underQuota<T>(call: () => Promise<T>): Promise<T> {
  for (let waits = 0; ; waits++) {
    try {
      return await call();
    } catch (err) {
      if (
        !(err instanceof PlacesApiError && err.status === 429) ||
        waits >= MAX_QUOTA_WAITS
      )
        throw err;
      console.log(
        `  Google per-minute quota reached — waiting ${QUOTA_WAIT_MS / 1000} s (${waits + 1}/${MAX_QUOTA_WAITS})`,
      );
      await new Promise((r) => setTimeout(r, QUOTA_WAIT_MS));
    }
  }
}
