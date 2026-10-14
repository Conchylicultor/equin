import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Create a song from an already-uploaded MusicXML attachment. The server reads
 * the stored document back, parses it (a parse error fails the request) and
 * derives the song's metadata itself, then writes the generic `sonata_songs` row
 * and this source's extension row — or answers the song that already holds the
 * same document (content-hash dedup).
 */
export const createMusicXmlSong = defineEndpoint({
  route: "POST /api/sonata/songs/musicxml",
  body: z.object({ attachmentId: z.string() }),
  response: z.object({ id: z.string(), title: z.string() }),
});

/**
 * One song's MusicXML attachment, or `null` if the song carries none. Used by
 * the source's `hydrate` to resolve the document to fetch.
 */
export const getSongMusicXml = defineEndpoint({
  route: "GET /api/sonata/songs/:id/musicxml",
  response: z.object({ attachmentId: z.string() }).nullable(),
});
