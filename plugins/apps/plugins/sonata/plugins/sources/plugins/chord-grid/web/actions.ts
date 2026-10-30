import { useCallback } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  updateChordGridSong,
  type UpdateChordGridSongBody,
} from "../shared/endpoints";

/**
 * Persist a chord-grid song's authored text (plus its `compile()`-derived
 * metrics).
 *
 * A grid edit is a **user-triggered mutation** — the user typed those bars — so
 * this goes through `useEndpointMutation` rather than a discarded
 * `void fetchEndpoint(...)`: a failed write must not vanish into a contextless
 * browser-rejection crash. Passing no `onError` opts into the global error toast,
 * so the user learns their grid did not save instead of silently losing it on the
 * next reload. Mirrors `useSaveRhythm` in `rich/rhythm-controls`.
 *
 * The save is still debounced and *optimistic*: the shell context (`rawById`) is
 * the live source of truth and drives the score recompile immediately; this only
 * catches the server up.
 */
export function useSaveChordGrid(): (
  songId: string,
  body: UpdateChordGridSongBody,
) => void {
  const { mutate } = useEndpointMutation(updateChordGridSong);
  return useCallback(
    (songId, body) => mutate({ params: { id: songId }, body }),
    [mutate],
  );
}
