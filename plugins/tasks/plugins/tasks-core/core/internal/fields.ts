import type { FieldsRecord } from "@plugins/fields/core";
import { nullable } from "@plugins/fields/core";
import {
  textField,
  enumTextField,
  parsedTextField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { rankField } from "@plugins/fields/plugins/rank/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  FALLBACK_MODEL,
  StoredModelSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  DEFAULT_WORKSPACE,
  WorkspaceSpecSchema,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import {
  ConversationStatusSchema,
  ConversationWorkingOnSchema,
} from "../conversation-status";
import { TASK_AUTHOR_KINDS, TASK_AUTHOR_KIND_OPTIONS } from "../task-author";
import {
  CONVERSATION_LAUNCH_CAUSES,
  CONVERSATION_LAUNCH_CAUSE_OPTIONS,
} from "../launch-cause";

// Web-safe field records for the tasks / attempts / task_dependencies / pushes /
// conversations FK cluster. One `FieldsRecord` per table, keyed by JS prop name
// IN COLUMN ORDER (matching `server/internal/tables.ts`). `defineEntity` (server
// only) derives the physical pgTable from these; `core/internal/schema.ts`
// derives the public wire schemas from the SAME records via `fieldsToZodObject`.
//
// Living in `core/` keeps these off the server-only `defineEntity` path so the
// browser can evaluate the public schemas without dragging in
// `drizzle-orm/pg-core` / the `fields.storage` server registry.
//
// Nullability rides on the field schema (`nullable(...)` ⇒ no `.notNull()`); DB
// defaults and FKs are DDL-only and declared in the entity meta, not here.

export const taskFields = {
  id: textField(),
  // Display-only organization hierarchy (a "folder"). NOT a dependency.
  // Labelled: the tasks tree (`taskWindow`) lists it — a tree's parent is a
  // filterable field.
  folderId: nullable(textField({ label: "Folder" })),
  groupId: nullable(textField()),
  // Monotone dependency-tree membership label (union-find representative =
  // min(id) over the cluster). A new task is its own singleton (`clusterId =
  // id`, written on insert); grows on edge creation, NEVER shrinks on edge
  // removal — that is the point. Total, so every task names its scope: the
  // cluster-scoped read (`taskClusterRows`) is one tuple per label.
  clusterId: textField(),
  // Labels and the title flag are what every task list shows (the fields
  // spelling: `liveCollection({ from: tasksEntityRef, pick })`).
  title: textField({ label: "Title", primary: true }),
  // Whether `title` is a machine-generated label rather than human-authored.
  titleAuto: boolField(),
  description: nullable(textField()),
  // Who decided the task should exist (`../task-author.ts`): every task
  // list's "Created by" field. An agent author names its conversation in
  // `authorConversationId` (the CHECK `tasks_author_agent_has_conversation`
  // ties the two).
  authorKind: enumTextField(TASK_AUTHOR_KINDS, {
    label: "Created by",
    options: TASK_AUTHOR_KIND_OPTIONS,
  }),
  authorConversationId: nullable(textField({ label: "Author" })),
  // The plugin id of the surface that filed the task (Wish, the task list,
  // `add_task`, triage, an automation, …). Null only for tasks filed before
  // it was recorded.
  filedFrom: nullable(textField({ label: "Filed from" })),
  droppedAt: nullable(dateField()),
  heldAt: nullable(dateField()),
  rank: rankField(),
  createdAt: dateField(),
  updatedAt: dateField({ label: "Updated" }),
} satisfies FieldsRecord;

export const attemptFields = {
  id: textField(),
  taskId: textField(),
  // The attempt's workspace directory — `<root of its kind>/<id>`. Named for
  // the worktree, the first kind; every kind honours the same shape.
  worktreePath: textField(),
  createdAt: dateField(),
  updatedAt: dateField(),
  // Where the attempt's conversations run (conversations/workspace). Rows
  // written before the column existed are worktrees (the DB default).
  workspace: jsonField<WorkspaceSpec>({
    schema: WorkspaceSpecSchema,
    default: DEFAULT_WORKSPACE,
  }),
} satisfies FieldsRecord;

export const taskDependencyFields = {
  taskId: textField(),
  dependsOnTaskId: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

export const pushFields = {
  id: textField(),
  attemptId: textField({ label: "Attempt" }),
  // Soft attribution to the conversation that ran the push (no FK).
  conversationId: nullable(textField()),
  sha: textField(),
  pushId: textField(),
  message: textField(),
  createdAt: dateField(),
} satisfies FieldsRecord;

// An attempt's DELIVERY that is not a push: a workspace with no git (a scratch
// dir) records the moment its agent handed its work over. One row per attempt
// (the first delivery's instant; a later one replaces the summary). With the
// pushes it is the "landed" fact `attempts_v` reads (rollup-spec.ts) — a fact,
// never a claimed status (I6).
export const attemptDeliveryFields = {
  attemptId: textField(),
  // Soft attribution to the conversation that delivered (no FK), like pushes.
  conversationId: textField(),
  summary: textField(),
  deliveredAt: dateField(),
} satisfies FieldsRecord;

export const conversationFields = {
  id: textField(),
  attemptId: textField(),
  // Labels, the title flag and each enum's options are what every list of
  // conversations shows (the fields spelling: `liveCollection({ from, pick })`).
  title: nullable(textField({ label: "Title", primary: true })),
  // Narrowed text columns: the DDL stays plain `text`, and the field's own
  // schema is what decodes it (the `text` storage arm), so the union in the
  // value type is derived rather than asserted.
  status: enumTextField(ConversationStatusSchema.options, {
    label: "Status",
    options: {
      starting: { label: "Starting" },
      working: { label: "Working" },
      waiting: { label: "Waiting" },
      gone: { label: "Gone" },
      done: { label: "Done" },
    },
  }),
  runtime: textField({ label: "Runtime" }),
  // The concrete version the conversation RAN — never a family: a model choice
  // ("opus") is resolved at spawn, before this row is written.
  //
  // TOLERANT on purpose, unlike its siblings. Model ids get renamed and rows
  // outlive the rename. A strict decoder here would throw on reading such a
  // row; `StoredModelSchema` normalizes it and fires the deduped corruption
  // report — the same guard the
  // live-state resource already carried, moved down to the column so it reaches
  // the server-side readers too.
  //
  // The baseline's default version (`FALLBACK_MODEL`) is the wire/backfill default, where the tuple form
  // silently gave `"fable-5-1"` — the first entry of the enum, i.e. tuple order
  // rather than anyone's decision. Nothing observable changes: the column is
  // notNull with no DB default (every insert passes the resolved version), so
  // every row carries a model and the wire schema's `.default()` never fires. The general factory just makes the value
  // something someone had to choose.
  //
  // Its options are the live model catalog's (a list reads them through the
  // conversations entity's presentation), never a static set.
  model: parsedTextField(StoredModelSchema, {
    label: "Model",
    default: FALLBACK_MODEL,
  }),
  kind: enumTextField(["user", "agent", "system"] as const, {
    label: "Kind",
    options: {
      user: { label: "User" },
      agent: { label: "Agent" },
      system: { label: "System" },
    },
  }),
  claudeSessionId: nullable(textField()),
  waitingFor: nullable(textField()),
  workingOn: nullable(enumTextField(ConversationWorkingOnSchema.options)),
  // Set by the status reconciler while it cannot check `status` against the
  // agent's own head (the backend has not applied the agent's latest events,
  // or the runtime did not answer): `status` is then the last KNOWN one, and
  // readers render "Unknown" instead of claiming it. Cleared on the next
  // reconcile that could check.
  statusUnverifiedSince: nullable(dateField()),
  // When `status` last took the value it has now, stamped by the database in
  // the same write that changes it (`statusWrite` in tasks-core's mutations) —
  // so a reader can say how long the agent has been working, or waiting, from
  // its first look, whoever was watching when the status moved. Null on a row
  // whose status has not changed since the column was added.
  statusSince: nullable(dateField()),
  // Why it was launched now, and the plugin that launched it (for an
  // auto-start launch, the one that armed the task). `launchedFrom` is null
  // only on rows launched before it was tracked. See ../launch-cause.ts.
  launchCause: enumTextField(CONVERSATION_LAUNCH_CAUSES, {
    label: "Launched",
    options: CONVERSATION_LAUNCH_CAUSE_OPTIONS,
  }),
  launchedFrom: nullable(textField({ label: "Launched from" })),
  createdAt: dateField({ label: "Created" }),
  // Last activity. Sortable in the lists: it is DERIVED (a DB trigger) and
  // moves only on a title / model edit and the working ⇄ reply status
  // transitions — never on the status reconciler's `waitingFor` /
  // `lastViewedAt` writes — so a live window ordered by it re-sorts on real
  // activity only.
  updatedAt: dateField({ label: "Updated" }),
  endedAt: nullable(dateField({ label: "Ended" })),
  closeRequested: boolField(),
  // Hibernation lifecycle (orthogonal to `status`).
  hibernatedAt: nullable(dateField()),
  // Set while a hibernation resume brings the agent process back up: the row
  // keeps the status the user saw (`waiting`) instead of passing through
  // `starting`, and this is what the turn ledger holds sent turns on until
  // the process answers. Cleared by the status reconciler once the runtime
  // reports the session live (or the process never came up).
  resumingSince: nullable(dateField()),
  lastViewedAt: nullable(dateField()),
} satisfies FieldsRecord;
