import { mapRow, useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { attachmentBytes } from "@plugins/infra/plugins/attachments/core";
import type { SourceHydration } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { songMidiRows } from "../shared/resources";

const ABSENT: SourceHydration = { kind: "absent" };

/**
 * Hydrate a song's MIDI source, live: its row names the stored attachment,
 * whose bytes (an `ArrayBuffer`) are the raw for `useLoadDocument`. `absent`
 * for a song that carries no MIDI (so it's skipped in the library's generic
 * collection).
 */
export function useHydration(songId: string): ResourceResult<SourceHydration> {
  const row = mapRow(useLiveRow(songMidiRows, songId), (r) => r);
  const attachmentId = foldResource(row, {
    loading: () => null,
    error: () => null,
    ready: (r) => r?.attachmentId ?? null,
  });
  const bytes = useLive(
    attachmentBytes,
    attachmentId === null ? null : { id: attachmentId },
  );
  // No MIDI row: nothing to read the bytes of.
  if (row.status === "ready" && row.data === null) {
    return mapResource(row, () => ABSENT);
  }
  return mapResource(
    combineResources({ row, bytes }),
    ({ bytes: raw }): SourceHydration => ({ kind: "raw", raw }),
  );
}
