import { mapRow, useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { attachmentBytes } from "@plugins/infra/plugins/attachments/core";
import type { SourceHydration } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { songMusicXmlRows } from "../shared/resources";

const ABSENT: SourceHydration = { kind: "absent" };

/**
 * Hydrate a song's MusicXML source, live: its row names the stored
 * attachment, whose bytes decoded as text are the raw for `useLoadDocument`.
 * `absent` for a song with no MusicXML.
 */
export function useHydration(songId: string): ResourceResult<SourceHydration> {
  const row = mapRow(useLiveRow(songMusicXmlRows, songId), (r) => r);
  const attachmentId = foldResource(row, {
    loading: () => null,
    error: () => null,
    ready: (r) => r?.attachmentId ?? null,
  });
  const bytes = useLive(
    attachmentBytes,
    attachmentId === null ? null : { id: attachmentId },
  );
  // No MusicXML row: nothing to read the bytes of.
  if (row.status === "ready" && row.data === null) {
    return mapResource(row, () => ABSENT);
  }
  return mapResource(
    combineResources({ row, bytes }),
    ({ bytes: buf }): SourceHydration => ({
      kind: "raw",
      raw: new TextDecoder().decode(buf),
    }),
  );
}
