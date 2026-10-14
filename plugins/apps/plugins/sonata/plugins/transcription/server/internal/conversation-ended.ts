import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { markFailed, transcribingSongOf } from "./state";

/**
 * A transcription whose conversation was closed before it submitted a score
 * has failed: nothing else will ever fill the song. Bound to every
 * conversation status change (`conversation.statusChanged`, which has no
 * filter columns): anything but a close (`done`) returns at once, and only a
 * close of a conversation still transcribing writes. A hibernated (`gone`)
 * conversation is resumable, so it is not a failure.
 */
export const transcriptionConversationEndedJob = defineJob({
  name: "sonata.transcription.conversation-ended",
  description:
    "Marks a Sonata transcription failed when its conversation is closed before the agent submitted a score, so the song offers a retry.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({ conversationId: z.string(), status: z.string() })
    .passthrough(),
  run: async ({ event }) => {
    if (!event || event.status !== "done") return;
    const songId = await transcribingSongOf(event.conversationId);
    if (songId === null) return;
    await markFailed(
      songId,
      "The conversation was closed before a transcription was submitted.",
    );
  },
});
