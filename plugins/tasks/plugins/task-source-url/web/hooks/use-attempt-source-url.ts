import { useLive } from "@plugins/network/plugins/live/web";
import { attemptSourceUrl } from "../../core";

/** The page this attempt's task was filed from (see `attemptSourceUrl`). */
export function useAttemptSourceUrl(attemptId: string) {
  return useLive(attemptSourceUrl, { attemptId });
}
