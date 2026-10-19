import { useLive } from "@plugins/network/plugins/live/web";
import { threadRuns } from "../../core";

/**
 * The recent runs started under scratch `profile`, newest first — the live
 * window state (`loading` until the first answer, never a stand-in empty
 * list). `limit` defaults to the collection's (the latest few).
 */
export function useThreadRuns(profile: string, opts?: { limit?: number }) {
  return useLive(threadRuns, {
    where: { profile },
    ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
  });
}
