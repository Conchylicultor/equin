import type {
  SourceContext,
  SourceHydration,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { getAttachmentFile } from "@plugins/infra/plugins/attachments/core";
import { getSongMusicXml } from "../shared/endpoints";

/**
 * Hydrate a song's MusicXML source: resolve its stored attachment and hand back
 * the document text for `useLoadDocument`. `absent` for a song with no MusicXML.
 */
export async function hydrate(
  songId: string,
  { fetchEndpoint }: SourceContext,
): Promise<SourceHydration> {
  const row = await fetchEndpoint(getSongMusicXml, { id: songId });
  if (!row) return { kind: "absent" };
  const blob = await fetchEndpoint(getAttachmentFile, { id: row.attachmentId });
  return { kind: "raw", raw: await blob.text() };
}
