import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { scheduleTaskTitleUpgrade } from "./generate-title";

export const titleOnConversationCreatedJob = defineJob({
  name: "task-title.on-conversation-created",
  description:
    "Improves a task's title from the first prompt of a newly created conversation.",
  // instant: `scheduleTaskTitleUpgrade` is fire-and-forget — the Haiku call it
  // starts runs detached, so it never holds this slot.
  hold: "instant",
  input: z.object({}).passthrough(),
  dedup: "none",
  event: z
    .object({
      taskId: z.string(),
      prompt: z.string().optional(),
      kind: z.string().optional(),
    })
    .passthrough(),
  maxAttempts: 2,
  run: async ({ event }) => {
    if (!event?.prompt || event.kind === "system") return;
    scheduleTaskTitleUpgrade(event.taskId, event.prompt);
  },
});

export const titleOnUserTurnSentJob = defineJob({
  name: "task-title.on-user-turn-sent",
  description: "Improves a task's title from the user's latest message.",
  // instant: same fire-and-forget schedule as the job above.
  hold: "instant",
  input: z.object({}).passthrough(),
  dedup: "none",
  event: z
    .object({
      taskId: z.string(),
      text: z.string(),
    })
    .passthrough(),
  maxAttempts: 2,
  run: async ({ event }) => {
    if (!event?.text) return;
    scheduleTaskTitleUpgrade(event.taskId, event.text);
  },
});
