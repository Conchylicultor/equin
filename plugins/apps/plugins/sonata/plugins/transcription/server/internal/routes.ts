import {
  createSongRow,
  songAttachments,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { MUSICXML_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/musicxml/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import {
  getSongTranscription,
  retryTranscription,
  transcribeSong,
} from "../../shared/endpoints";
import { songTranscription } from "./tables";
import {
  assertCanLaunch,
  launchTranscription,
  placeholderTitle,
  resolveProfileSource,
  SONATA_CATEGORY_ID,
  TRANSCRIPTION_AUTHOR,
} from "./launch";

export const handleTranscribeSong = implement(
  transcribeSong,
  async ({ body }) => {
    const { input } = body;
    await assertCanLaunch();
    const source = await resolveProfileSource(input);
    const title = placeholderTitle(source);

    const songId = await createSongRow({
      title,
      composer: null,
      durationSec: 0,
      endBeat: 0,
      source: MUSICXML_SOURCE_ID,
    });
    // The uploads belong to the song, so the orphan sweep keeps them while the
    // agent (and any retry) needs them.
    if (input.kind === "files") {
      await songAttachments.add(songId, input.attachmentIds);
    }
    const task = await createTask({
      title: `Transcribe: ${title}`,
      author: TRANSCRIPTION_AUTHOR,
    });
    await setTaskCategory(task.id, SONATA_CATEGORY_ID);
    await songTranscription.upsert(songId, {
      status: "transcribing",
      input,
      taskId: task.id,
      conversationId: null,
      error: null,
    });
    await launchTranscription(songId, task.id, source);
    return { id: songId, title };
  },
);

export const handleRetryTranscription = implement(
  retryTranscription,
  async ({ params }) => {
    const songId = songIdKind.key(params.id);
    const row = await songTranscription.get(songId);
    if (!row)
      throw new HttpError(404, `No transcription for song ${params.id}`);
    if (row.status !== "failed") {
      throw new HttpError(
        409,
        `The transcription is ${row.status}; only a failed one can be retried`,
      );
    }
    await assertCanLaunch();
    const source = await resolveProfileSource(row.input);
    const conversationId = await launchTranscription(
      songId,
      row.taskId,
      source,
    );
    return { conversationId };
  },
);

export const handleGetSongTranscription = implement(
  getSongTranscription,
  async ({ params }) => {
    const row = await songTranscription.get(songIdKind.key(params.id));
    if (!row) return null;
    return { status: row.status, error: row.error };
  },
);
