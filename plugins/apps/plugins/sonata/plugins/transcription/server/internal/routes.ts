import {
  createSongRow,
  songAttachments,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { MUSICXML_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/musicxml/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { assertClaudeCodeReady } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import { setTaskWorkspace } from "@plugins/conversations/plugins/workspace/plugins/launch-option/server";
import {
  getSongTranscription,
  prepareTranscription,
  retryTranscription,
} from "../../shared/endpoints";
import type { TranscriptionInput } from "../../shared/input";
import { songTranscription } from "./tables";
import {
  assertCanLaunch,
  launchPrompt,
  launchTranscription,
  placeholderTitle,
  transcriptionWorkspace,
  resolveProfileSource,
  SONATA_CATEGORY_ID,
  TRANSCRIPTION_AUTHOR,
} from "./launch";

export const handlePrepareTranscription = implement(
  prepareTranscription,
  async ({ body }) => {
    const input: TranscriptionInput = {
      kind: "prompt",
      prompt: body.text,
      attachmentIds: [...new Set(extractAttachmentIds(body.text))],
    };
    // Refused before anything is written; the model is the launch's to check.
    await assertClaudeCodeReady();
    const source = await resolveProfileSource(input);
    const title = placeholderTitle(input, source);
    const prompt = launchPrompt(input);

    const songId = await createSongRow({
      title,
      composer: null,
      durationSec: 0,
      endBeat: 0,
      source: MUSICXML_SOURCE_ID,
    });
    // The uploads belong to the song, so the orphan sweep keeps them while the
    // agent (and any retry) needs them.
    if (input.attachmentIds.length > 0) {
      await songAttachments.add(songId, input.attachmentIds);
    }
    const task = await createTask({
      title: `Transcribe: ${title}`,
      description: prompt,
      author: TRANSCRIPTION_AUTHOR,
    });
    await setTaskCategory(task.id, SONATA_CATEGORY_ID);
    // The task runs in the transcription workspace however it is launched —
    // now by the form, or later from the agent manager if the user filed it
    // without starting.
    await setTaskWorkspace(task.id, transcriptionWorkspace(songId, source));
    // `conversationId` is recorded when the launch's conversation appears
    // (`conversation-status.ts`).
    await songTranscription.upsert(songId, {
      status: "transcribing",
      input,
      taskId: task.id,
      conversationId: null,
      error: null,
    });
    return { song: { id: songId, title }, taskId: task.id, prompt };
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
      row.input,
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
