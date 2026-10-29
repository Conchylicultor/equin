import { useCallback } from "react";
import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { setTransposeEndpoint } from "../shared/endpoints";

// Predicted write: the `transposes` row shows the new offset at once, so the
// observer (and the audio it drives) follows the request; the server's row
// confirms it. Named `save*` (not `set*`) to stay distinct from the in-memory
// write of the loaded song's setting (`useWriteSongSetting(transposeSetting)`),
// which the control makes alongside this persistence call.
export function useSaveTranspose(): (
  songId: string,
  semitones: number,
) => void {
  const { mutate } = useLiveMutation(setTransposeEndpoint);
  return useCallback(
    (songId, semitones) =>
      mutate({ params: { id: songId }, body: { semitones } }),
    [mutate],
  );
}
