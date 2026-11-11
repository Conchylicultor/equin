import { useSyncExternalStore } from "react";
import type { YouTubePlayerController } from "@plugins/integrations/plugins/youtube/web";
import { boxAt, type Round } from "../../core";

const noSubscription = () => () => {};

/**
 * The position of the box sounding now, re-rendering only when it changes
 * (not every frame). Watched only while `active` (once the round is checked:
 * before, nothing on screen shows it).
 */
export function useSoundingBox(
  player: YouTubePlayerController,
  round: Round | null,
  active: boolean,
): number | null {
  const watching = active && round !== null;
  const read = (): number | null => {
    if (!watching) return null;
    const t = player.getPlayhead();
    return t === null ? null : (boxAt(round.boxes, t)?.position ?? null);
  };
  return useSyncExternalStore(
    watching ? player.subscribePlayhead : noSubscription,
    read,
    read,
  );
}
