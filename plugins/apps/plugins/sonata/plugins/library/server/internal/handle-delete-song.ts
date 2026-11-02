import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { deleteSong, songIdKind } from "../../core";
import { _songs } from "./tables";

export const handleDeleteSong = implement(deleteSong, async ({ params }) => {
  // FK cascade drops the link row in `sonata_songs_attachments`; the now-unlinked
  // attachment is reclaimed by the hourly orphan sweep.
  await db.delete(_songs).where(eq(_songs.id, songIdKind.key(params.id)));
});
