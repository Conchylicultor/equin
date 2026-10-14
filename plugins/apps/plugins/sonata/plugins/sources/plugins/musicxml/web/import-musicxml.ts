import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { parseMusicXml } from "../shared/parse";
import { MUSICXML_MIME } from "../shared/constants";
import { createMusicXmlSong } from "../shared/endpoints";

/** The library song a MusicXML file belongs to. */
export interface ImportedMusicXmlSong {
  id: string;
  title: string;
}

/**
 * Put a MusicXML file into the Sonata library: parse it (a malformed document
 * throws `MusicXmlParseError` before anything is uploaded), upload it as an
 * attachment and create the song — the server re-parses it for the metadata and
 * answers the existing song when the same document is already in the library.
 */
export async function importMusicXmlFile(
  file: File,
): Promise<ImportedMusicXmlSong> {
  const xml = await file.text();
  parseMusicXml(xml);
  const up = await uploadAttachment(
    new Blob([xml], { type: MUSICXML_MIME }),
    file.name,
    MUSICXML_MIME,
  );
  return fetchEndpoint(
    createMusicXmlSong,
    {},
    { body: { attachmentId: up.id } },
  );
}
