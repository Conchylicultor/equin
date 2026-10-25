import { useLive } from "@plugins/network/plugins/live/web";
import type { DefaultOpen } from "@plugins/primitives/plugins/detail-sections/web";
import { deploySecretsStatus } from "../../core";

/**
 * Show the section while loading (a card popping in a frame late is worse) and
 * whenever the composition needs at least one secret; hide it once it is
 * known to need none.
 */
export function useSecretsAvailable({
  deploymentId,
}: {
  deploymentId: string;
}): boolean {
  const result = useLive(deploySecretsStatus, { deploymentId });
  switch (result.status) {
    // Loading: keep the card so it does not pop in late. Error: keep it so the
    // body can say the read failed — hiding it would claim "needs nothing".
    case "loading":
    case "error":
      return true;
    case "ready":
      return result.data.length > 0;
  }
}

/**
 * Open by default while anything waits on the user, so a held deploy lands them
 * on it — `"pending"` until the rows load (the section primitive latches the
 * answer once known), open on a failed read so its error is seen.
 */
export function useSecretsDefaultOpen({
  deploymentId,
}: {
  deploymentId: string;
}): DefaultOpen {
  const result = useLive(deploySecretsStatus, { deploymentId });
  switch (result.status) {
    case "loading":
      return "pending";
    case "error":
      return true;
    case "ready":
      return result.data.some((r) => r.status !== "approved");
  }
}
