import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  choose,
  patchRow,
  removeRow,
  upsertRow,
} from "@plugins/network/plugins/live/core";
import { taskTriageNotes, taskTriageReads } from "./resources";
import { TRIAGE_STATES } from "./vocabulary";

/** What a triage request did. */
export const RequestTriageOutcomeSchema = z.discriminatedUnion("kind", [
  // Queued now (the dispatcher launches it when a slot frees).
  z.object({ kind: z.literal("queued") }),
  // Left alone: a run is already in flight, or (without `force`) the task
  // has a read already.
  z.object({ kind: z.literal("unchanged"), state: z.enum(TRIAGE_STATES) }),
]);
export type RequestTriageOutcome = z.infer<typeof RequestTriageOutcomeSchema>;

/**
 * Run (or re-run) triage of one task — any task, any track, whether or not an
 * automation is on. Queued first; a run already in flight is left alone. A
 * triage run's own task (`Triage: …`) is refused (400).
 */
export const runTriageEndpoint = defineEndpoint({
  route: "POST /api/tasks/:taskId/triage",
  response: RequestTriageOutcomeSchema,
  unpredicted: {
    reason: "server-decided",
    why: "It queues an LLM triage run and the returned queued or unchanged outcome is what the button reflects.",
  },
});

/**
 * The person's one-click answer to triage's question (`null` clears it) — one
 * of the answers the read offered. It approves nothing.
 */
export const answerTriageEndpoint = defineEndpoint({
  route: "PUT /api/tasks/:taskId/triage/answer",
  body: z.object({ answer: z.string().min(1).nullable() }),
  // The card offers only the row's own answers on a row it holds, so the
  // server's 400 / 404 cannot arise from it: the answer lands on the row.
  effect: (on) =>
    patchRow(
      on,
      taskTriageReads,
      ({ params }) => params.taskId,
      ({ body }) => ({ set: { answer: body.answer } }),
    ),
});

/**
 * The task's free-text note, fed to every triage run of it and to the
 * autopilot's launch prompt. Blank deletes it. Autosaved by the card.
 */
export const setTriageNoteEndpoint = defineEndpoint({
  route: "PUT /api/tasks/:taskId/triage/note",
  body: z.object({ note: z.string() }),
  // Blank deletes the note row, anything else upserts it (the server's rule).
  effect: (on) =>
    choose(on, ({ body }) => (body.note.trim() === "" ? "clear" : "set"), {
      clear: removeRow(on, taskTriageNotes, ({ params }) => params.taskId),
      set: upsertRow(
        on,
        taskTriageNotes,
        ({ params }) => params.taskId,
        (row, { params, body }) => ({
          ...row,
          taskId: params.taskId,
          note: body.note,
        }),
        { set: ({ body }) => ({ note: body.note }) },
      ),
    }),
});
