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
  TerminalMenuSchema,
  type TerminalMenu,
} from "@plugins/conversations/plugins/terminal-menu/core";
import {
  FALLBACK_MODEL,
  StoredModelSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  DEFAULT_WORKSPACE,
  WorkspaceSpecSchema,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import { ConversationStatusSchema } from "../conversation-status";

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
  folderId: nullable(textField()),
  groupId: nullable(textField()),
  // Monotone dependency-tree membership label (union-find representative =
  // min(id) over the cluster). NULL ⇒ never unioned ⇒ its own singleton cluster.
  // Grows on edge creation, NEVER shrinks on edge removal — that is the point.
  clusterId: nullable(textField()),
  title: textField(),
  // Whether `title` is a machine-generated label rather than human-authored.
  titleAuto: boolField(),
  description: nullable(textField()),
  // "user" for UI-created tasks, a conversation id for agent-created ones.
  author: nullable(textField()),
  droppedAt: nullable(dateField()),
  heldAt: nullable(dateField()),
  rank: rankField(),
  createdAt: dateField(),
  updatedAt: dateField(),
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
  attemptId: textField(),
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
  title: nullable(textField()),
  // Narrowed text columns: the DDL stays plain `text`, and the field's own
  // schema is what decodes it (the `text` storage arm), so the union in the
  // value type is derived rather than asserted.
  status: enumTextField(ConversationStatusSchema.options),
  runtime: textField(),
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
  model: parsedTextField(StoredModelSchema, {
    default: FALLBACK_MODEL,
  }),
  kind: enumTextField(["user", "agent", "system"] as const),
  claudeSessionId: nullable(textField()),
  waitingFor: nullable(textField()),
  spawnedBy: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
  endedAt: nullable(dateField()),
  closeRequested: boolField(),
  // Hibernation lifecycle (orthogonal to `status`).
  hibernatedAt: nullable(dateField()),
  lastViewedAt: nullable(dateField()),
  // The terminal menu the conversation is waiting on, read off its screen —
  // set exactly while `waitingFor` is the terminal-menu key, null otherwise.
  // A `jsonField` of `TerminalMenu | null` rather than `nullable(jsonField(…))`,
  // which would demand a stand-in menu as the (discarded) inner default.
  waitingMenu: jsonField<TerminalMenu | null>({
    schema: TerminalMenuSchema.nullable(),
    default: null,
  }),
} satisfies FieldsRecord;
