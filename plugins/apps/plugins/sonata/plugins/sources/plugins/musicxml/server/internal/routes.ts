import { implement } from "@plugins/infra/plugins/endpoints/server";
import { createMusicXmlSong } from "../../shared/endpoints";
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
