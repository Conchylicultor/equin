import { useCallback } from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { setKeyAutoDetectEndpoint } from "../shared/endpoints";

// Predicted write: the `keyAutoDetects` row shows the new mode at once and the
// server's row confirms it. Named `save*` (not `set*`) to stay distinct from
// the in-memory write of the loaded song's setting
// (`useWriteSongSetting(keyAutoDetectSetting)`), which a toggle handler makes
// alongside this persistence call.
export function useSaveKeyAutoDetect(): (
  songId: string,
  enabled: boolean,
) => void {
  const { mutate } = useLiveMutation(setKeyAutoDetectEndpoint);
  return useCallback(
    (songId, enabled) => mutate({ params: { id: songId }, body: { enabled } }),
    [mutate],
  );
}
