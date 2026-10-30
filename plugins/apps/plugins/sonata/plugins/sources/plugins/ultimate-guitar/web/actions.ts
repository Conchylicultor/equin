import { useCallback } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  updateUltimateGuitarSong,
  type CreateUltimateGuitarSongBody,
} from "../shared/endpoints";

/**
 * Persist a UG song's loaded `UgTab` snapshot (plus its `compile()`-derived
 * metrics).
 *
 * Loading a different tab in-player is a **user-triggered mutation**, so this
 * goes through `useEndpointMutation` rather than a discarded
 * `void fetchEndpoint(...)`: a failed write must not vanish into a contextless
 * browser-rejection crash. Passing no `onError` opts into the global error toast,
 * so the user learns the tab did not save instead of silently losing it on the
 * next reload. Mirrors `useSaveRhythm` in `rich/rhythm-controls`.
 *
 * This `PUT` also syncs the parent song's title (← `songName`); the toolbar title
 * re-renders off the library's live `songs` value, not an in-memory mirror.
 */
export function useSaveUltimateGuitar(): (
  songId: string,
  body: CreateUltimateGuitarSongBody,
) => void {
  const { mutate } = useEndpointMutation(updateUltimateGuitarSong);
  return useCallback(
    (songId, body) => mutate({ params: { id: songId }, body }),
    [mutate],
  );
}
