import type {
  SourceContext,
  SourceHydration,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { getAttachmentFile } from "@plugins/infra/plugins/attachments/core";
import { getSongMidi } from "../shared/endpoints";

/**
 * Hydrate a song's MIDI source: resolve its stored attachment, fetch the bytes,
 * and hand back the ArrayBuffer for `useLoadDocument`. Returns `absent` for a song
 * that carries no MIDI (so it's skipped in the library's generic collection).
 */
export async function hydrate(
  songId: string,
  { fetchEndpoint }: SourceContext,
): Promise<SourceHydration> {
  const midi = await fetchEndpoint(getSongMidi, { id: songId });
  if (!midi) return { kind: "absent" };
  const blob = await fetchEndpoint(getAttachmentFile, {
    id: midi.attachmentId,
  });
  return { kind: "raw", raw: await blob.arrayBuffer() };
}
