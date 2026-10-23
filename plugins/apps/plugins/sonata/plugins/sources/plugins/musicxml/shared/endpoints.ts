import { z } from "zod";
import {
  blob,
  defineEndpoint,
  endpointPath,
} from "@plugins/infra/plugins/endpoints/core";

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

/**
 * One song's cover: a schematic grand staff of its opening bars, drawn on the
 * server from the song's own MusicXML (`covers` renders and caches it). Raw —
 * it answers SVG bytes. The last segment is `<version>.svg`, the version the
 * row's `sourcesChangedAt` (epoch ms) as the card building the URL knew it: the
 * response is `immutable` while it is current, `no-store` once stale. One
 * whole-segment param, because the router matches whole segments only.
 */
export const getSongMusicXmlCover = defineEndpoint({
  route: "GET /api/sonata/songs/:id/musicxml/cover/:file",
  response: blob(),
});

/** The URL of a song's MusicXML cover, versioned by its `sourcesChangedAt`. */
export function musicXmlCoverUrl(id: string, sourcesChangedAt: Date): string {
  return endpointPath(getSongMusicXmlCover, {
    id,
    file: `${sourcesChangedAt.getTime()}.svg`,
  });
}
