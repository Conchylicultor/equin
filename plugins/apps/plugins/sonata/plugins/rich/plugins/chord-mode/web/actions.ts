import { useCallback } from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { setChordModeEndpoint } from "../shared/endpoints";

/**
 * Persist a song's chord mode. A predicted write: the `chordModes` row shows the
 * new mode at once (the toggle also writes the loaded song's `chordModeSetting`
 * for instant re-voicing) and the server's row confirms it; a rejection is
 * toasted by the transport. Named `save*` (not `set*`) to stay distinct from
 * that in-memory write (`useWriteSongSetting`).
 */
export function useSaveChordMode(): (songId: string, enabled: boolean) => void {
  const { mutate } = useLiveMutation(setChordModeEndpoint);
  return useCallback(
    (songId, enabled) => mutate({ params: { id: songId }, body: { enabled } }),
    [mutate],
  );
}
