import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { createMusicXmlSong, getSongMusicXml } from "../../shared/endpoints";
import { songMusicXml } from "./tables";
import { createMusicXmlSongFromAttachment } from "./import";

/**
 * Create a MusicXML-backed song from the client's already-uploaded attachment.
 * `id` may be an existing song's: the same document imported twice opens the
 * song the first import made.
 */
export const handleCreateMusicXmlSong = implement(
  createMusicXmlSong,
  async ({ body }) => createMusicXmlSongFromAttachment(body.attachmentId),
);

/** One song's MusicXML attachment, or null. */
export const handleGetSongMusicXml = implement(
  getSongMusicXml,
  async ({ params }) => {
    const row = await songMusicXml.get(songIdKind.key(params.id));
    if (!row) return null;
    return { attachmentId: row.attachmentId };
  },
);
