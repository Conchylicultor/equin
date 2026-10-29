import { useCallback } from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import type { SwingOverride } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { setSwingEndpoint } from "../shared/endpoints";

// Predicted write: the `swings` row shows the override at once (the loaded
// song's setting is written alongside, `useWriteSongSetting(swingSetting)`) and
// the server's row confirms it.
export function useSaveSwing(): (
  songId: string,
  override: SwingOverride,
) => void {
  const { mutate } = useLiveMutation(setSwingEndpoint);
  return useCallback(
    (songId, override) => mutate({ params: { id: songId }, body: override }),
    [mutate],
  );
}
