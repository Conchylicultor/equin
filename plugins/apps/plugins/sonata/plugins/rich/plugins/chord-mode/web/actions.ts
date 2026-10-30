import { useCallback } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { setChordModeEndpoint } from "../shared/endpoints";

/**
 * Persist a song's chord mode.
 *
 * The toggle is a **user-triggered mutation**, so this goes through
 * `useEndpointMutation` rather than a discarded `void fetchEndpoint(...)`: a
 * failed write must not vanish into a contextless browser-rejection crash.
 * Passing no `onError` opts into the global error toast, so the user learns the
 * mode did not save instead of silently losing it on the next reload.
 *
 * The write is still *optimistic*: the toggle writes the loaded song's
 * `chordModeSetting` first (instant re-voicing), and the `chordModes` row push
 * re-affirms server truth through the observer. Named `save*` (not `set*`) to
 * stay distinct from that in-memory write (`useWriteSongSetting`).
 */
export function useSaveChordMode(): (songId: string, enabled: boolean) => void {
  const { mutate } = useEndpointMutation(setChordModeEndpoint);
  return useCallback(
    (songId, enabled) => mutate({ params: { id: songId }, body: { enabled } }),
    [mutate],
  );
}
