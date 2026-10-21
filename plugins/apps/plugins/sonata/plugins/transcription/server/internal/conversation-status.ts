import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { markFailed, markTranscribing, transcriptionOfTask } from "./state";

/**
 * Follows the conversations of every transcription task, bound to every
 * conversation status change (`conversation.statusChanged`, which has no
 * filter columns, so anything not under a transcribing song's task returns at
 * once):
 *
 * - A NEW conversation under the task is the run to watch: it becomes the
 *   song's `conversationId` ("Open conversation"). That is how a launch the
 *   song did not make itself is recorded — the form's standard task launch, or
 *   the task started later from the agent manager.
 * - The song's conversation closed (`done`) before it submitted a score: the
 *   transcription failed, since nothing else will ever fill the song. A
 *   hibernated (`gone`) conversation is resumable, so it is not a failure.
 *   Nor is an agent that ended its turn without submitting (`waiting`): the
 *   thread shows it, and the user replies.
 * - A FAILED song's own conversation working again — the user replied in its
 *   thread, whose composer resumes even a closed conversation: the song is
 *   transcribing again, so its badge and pending label follow the run.
 */
export const transcriptionConversationStatusJob = defineJob({
  name: "sonata.transcription.conversation-status",
  description:
    "Records the conversation a Sonata transcription task launched on its song, marks the transcription failed when that conversation is closed before the agent submitted a score (so the song offers a retry), and transcribing again when a failed song's conversation is resumed from its thread.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      taskId: z.string().nullable(),
      status: z.string(),
    })
    .passthrough(),
  run: async ({ event }) => {
    if (!event?.taskId) return;
    const t = await transcriptionOfTask(event.taskId);
    if (t === null || t.status === "ready") return;
    if (t.status === "failed") {
      if (
        t.conversationId === event.conversationId &&
        (event.status === "starting" || event.status === "working")
      ) {
        await markTranscribing(t.songId, event.conversationId);
      }
      return;
    }
    if (event.status === "done") {
      if (t.conversationId !== event.conversationId) return;
      await markFailed(
        t.songId,
        "The conversation was closed before a transcription was submitted.",
      );
      return;
    }
    if (t.conversationId !== event.conversationId) {
      await markTranscribing(t.songId, event.conversationId);
    }
  },
});
