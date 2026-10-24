import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { tasksEntityRef } from "@plugins/tasks/plugins/tasks-core/core";
import {
  NOT_TRIAGED_META,
  TRIAGE_PRIORITIES,
  TRIAGE_PRIORITY_META,
  TRIAGE_RISK_META,
  TRIAGE_RISKS,
  TRIAGE_STALE_REASON_META,
  TRIAGE_STALE_REASONS,
  TRIAGE_STATE_META,
  TRIAGE_STATES,
  TRIAGE_TASK_TYPE_META,
  TRIAGE_TASK_TYPES,
  TRIAGE_VERDICT_META,
  TRIAGE_VERDICTS,
} from "./vocabulary";

const NOT_SET = { label: "Not triaged", quiet: true } as const;

// A task's triage: one row per task in the `tasks_ext_triage` entity-extension
// table (1:1, FK CASCADE on task delete), which `server/internal/tables.ts`
// builds from this shape. A row exists once triage was asked for; `state` is
// the run's (`TRIAGE_STATES`), and the result fields are null until a read
// lands — read the row through `parseTriageRead`, never field by field, so a
// result cannot be reached in a state that has none.
//
// The latest run wins: a re-run keeps the previous read on the row (shown
// greyed while it runs) until the new one is submitted. `sourceTitle` /
// `sourceDescription` are the task's text as the read saw it — the edited-stale
// check compares against them (server only). `mainSha` is the main commit it
// read the code at.
//
// It EXPOSES `state` (as `triage`; a task with no row reads NULL, "Not triaged"),
// `priority`, `taskType` and `triagedAt` to every list whose rows reach a task
// (`exposes` — the task list): filter, sort and group by them with no code in
// any list.
export const taskTriageShape = defineExtensionShape({
  key: "taskId",
  fields: {
    state: enumTextField(TRIAGE_STATES, {
      label: "Triage",
      options: TRIAGE_STATE_META,
    }),
    staleReason: nullable(
      enumTextField(TRIAGE_STALE_REASONS, {
        label: "Stale because",
        options: TRIAGE_STALE_REASON_META,
      }),
    ),
    sourceTitle: nullable(textField()),
    sourceDescription: nullable(textField()),
    // The latest run's conversation ("Conversation ↗"), and the run's own task
    // (a `Triage: <title>` task in the System category, never the triaged one).
    conversationId: nullable(textField()),
    runTaskId: nullable(textField()),
    // When triage was last asked for (orders the queue), when its run started
    // (the 30-min backstop), when its read landed.
    requestedAt: dateField({ label: "Requested" }),
    startedAt: nullable(dateField({ label: "Started" })),
    triagedAt: nullable(dateField({ label: "Last triaged" })),
    // Why the latest run failed; null unless `state` is `failed`.
    error: nullable(textField()),
    verdict: nullable(
      enumTextField(TRIAGE_VERDICTS, {
        label: "Verdict",
        options: TRIAGE_VERDICT_META,
      }),
    ),
    priority: nullable(
      enumTextField(TRIAGE_PRIORITIES, {
        label: "Priority",
        options: TRIAGE_PRIORITY_META,
      }),
    ),
    taskType: nullable(
      enumTextField(TRIAGE_TASK_TYPES, {
        label: "Type",
        options: TRIAGE_TASK_TYPE_META,
      }),
    ),
    risk: nullable(
      enumTextField(TRIAGE_RISKS, {
        label: "Risk",
        options: TRIAGE_RISK_META,
      }),
    ),
    context: nullable(textField()),
    question: nullable(textField()),
    answers: jsonField({ schema: z.array(z.string()), default: [] }),
    // The person's one-click answer to `question` (one of `answers`).
    answer: nullable(textField()),
    areas: jsonField({ schema: z.array(z.string()), default: [] }),
    mainSha: nullable(textField()),
  },
  serverOnly: ["sourceTitle", "sourceDescription"],
  exposes: {
    parent: tasksEntityRef,
    name: "triage",
    fields: {
      state: {
        label: "Triage",
        as: "triage",
        options: { ...TRIAGE_STATE_META, null: NOT_TRIAGED_META },
      },
      priority: {
        label: "Priority",
        options: { ...TRIAGE_PRIORITY_META, null: NOT_SET },
      },
      taskType: {
        label: "Type",
        options: { ...TRIAGE_TASK_TYPE_META, null: NOT_SET },
      },
      triagedAt: { label: "Last triaged" },
    },
  },
});
export const TaskTriageRowSchema = taskTriageShape.schema;
/** A `tasks_ext_triage` wire row — read it through `parseTriageRead`. */
export type TaskTriageRow = z.infer<typeof TaskTriageRowSchema>;

/**
 * The triage rows, read three ways from one declaration:
 *
 * - `useLiveRow(taskTriageReads, taskId)` — ONE task's triage (the card).
 *   `found: false` ⇒ not triaged.
 * - `useLive(taskTriageReads, { ids })` — the triage of the tasks a surface
 *   shows (the autopilot's launch list joins it to its candidates).
 * - `useLive(taskTriageReads, { where: { state: "queued" } })` — a window by
 *   state, oldest request first (the card's "2 ahead").
 *
 * A LIST of tasks reads none of these: `state`, `priority`, `taskType` and
 * `triagedAt` are exposed into its rows (`taskTriageShape.exposes`).
 */
export const taskTriageReads = liveCollection("task-triage.reads", {
  from: taskTriageShape,
  pick: ["state", "priority", "taskType", "verdict", "risk", "triagedAt"],
  id: "taskId",
  sortable: ["requestedAt", "triagedAt"],
  default: { orderBy: [["requestedAt", "asc"]], limit: 100 },
  maxLimit: 1000,
});

// A free-text note about a task, fed to every triage run of it (`{{note}}`)
// and to the autopilot's launch prompt. Its own 1:1 extension
// (`tasks_ext_triage_note`), since a note exists before any triage has run.
// Written only by the person (`PUT /api/tasks/:taskId/triage/note`); an empty
// note deletes the row.
export const taskTriageNoteShape = defineExtensionShape({
  key: "taskId",
  fields: { note: textField() },
});
export const TaskTriageNoteRowSchema = taskTriageNoteShape.schema;
export type TaskTriageNoteRow = z.infer<typeof TaskTriageNoteRowSchema>;

/** One task's note: `useLiveRow(taskTriageNotes, taskId)` (`found: false` ⇒ none). */
export const taskTriageNotes = liveCollection("task-triage.notes", {
  from: taskTriageNoteShape,
  id: "taskId",
});
