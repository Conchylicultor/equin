import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { updateSongMeta } from "@plugins/apps/plugins/sonata/plugins/library/server";
import {
  songIdKind,
  type SongId,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { TranscriptionStatus } from "../../core";
import { songTranscription } from "./tables";

// Every status write stamps the song row (`updateSongMeta` with no field), so
// an open player re-hydrates and swaps the pending body for the score or the
// failure — the library's push-driven re-hydration (`sourcesChangedAt`).

/** A run of the transcription is under way in `conversationId`. */
export async function markTranscribing(
  songId: SongId,
  conversationId: string,
): Promise<void> {
  await songTranscription.update(songId, {
    status: "transcribing",
    conversationId,
    error: null,
  });
  await updateSongMeta({ id: songId });
}

/** The agent's score is the song's now. */
export async function markReady(songId: SongId): Promise<void> {
  await songTranscription.update(songId, { status: "ready", error: null });
  await updateSongMeta({ id: songId });
}

/** The latest run failed; the song offers a retry. */
export async function markFailed(songId: SongId, error: string): Promise<void> {
  await songTranscription.update(songId, { status: "failed", error });
  await updateSongMeta({ id: songId });
}

/**
 * The transcription running under `taskId`, if any — how a conversation is
 * matched to its song: by its task, whoever launched it.
 */
export async function transcriptionOfTask(taskId: string): Promise<{
  songId: SongId;
  status: TranscriptionStatus;
  conversationId: string | null;
} | null> {
  const t = songTranscription.table;
  const [row] = await db
    .select({
      songId: t.songId,
      status: t.status,
      conversationId: t.conversationId,
    })
    .from(t)
    .where(eq(t.taskId, taskId))
    .limit(1);
  return row ? { ...row, songId: songIdKind.key(row.songId) } : null;
}
