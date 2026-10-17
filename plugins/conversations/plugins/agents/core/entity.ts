import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { rankField } from "@plugins/fields/plugins/rank/plugins/config/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  DEFAULT_MODEL_CHOICE,
  StoredModelChoiceSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  SavedSymbolNameSchema,
  parseSavedSymbolName,
} from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { agentIdKind, agentLaunchIdKind } from "./id-kinds";

/**
 * An agent's fields, in column order — the `agents` table is built from them
 * (`server/internal/tables.ts`).
 */
export const agentFields = {
  id: idKindField(agentIdKind),
  parentId: nullable(textField({ label: "Parent" })),
  name: textField({ label: "Name", primary: true }),
  /**
   * NULL prompt → folder/category node (no launch button). Non-null →
   * launchable agent whose prompt is fed to the spawned conversation.
   */
  prompt: nullable(textField({ label: "Prompt" })),
  /**
   * A model choice: a family ("sonnet" — its newest version at launch) or a
   * pinned version. NULL = the default choice (the inner default is never
   * reached).
   */
  model: nullable(
    parsedTextField(StoredModelChoiceSchema, {
      label: "Model",
      default: DEFAULT_MODEL_CHOICE,
    }),
  ),
  /**
   * Avatar: a picked Material Symbols name (checked against the installed sets
   * on every read and write) + a colour key. Both null = the default
   * robot-arm/violet avatar.
   */
  icon: nullable(
    parsedTextField(SavedSymbolNameSchema, {
      default: parseSavedSymbolName("smart-toy"),
    }),
  ),
  iconColor: nullable(textField()),
  /** The stored key; a list reads it as a `Rank` (`rankValueField`). */
  rank: rankField(),
  createdAt: dateField({ label: "Created" }),
  updatedAt: dateField({ label: "Updated" }),
} satisfies FieldsRecord;

/** The `agents` entity — the user's agent roster (agents and folders). */
export const agentsEntityRef = entityRef("agents", agentFields);

/**
 * An agent launch's fields — the `agent_launches` table is built from them.
 * `taskId` is a soft link to tasks: the tasks plugin owns that table's
 * lifecycle, and launches stay discoverable even if the target task is later
 * deleted by another flow.
 */
export const agentLaunchFields = {
  id: idKindField(agentLaunchIdKind),
  agentId: textField({ label: "Agent" }),
  taskId: textField({ label: "Task" }),
  createdAt: dateField({ label: "Launched" }),
} satisfies FieldsRecord;

/** The `agent_launches` entity — one row per launch of an agent onto a task. */
export const agentLaunchesEntityRef = entityRef(
  "agent_launches",
  agentLaunchFields,
);
