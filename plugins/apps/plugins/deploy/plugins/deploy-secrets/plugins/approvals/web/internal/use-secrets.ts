import { useLive } from "@plugins/network/plugins/live/web";
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
