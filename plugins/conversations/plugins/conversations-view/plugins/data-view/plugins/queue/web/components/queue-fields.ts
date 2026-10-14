import {
  fieldOverrides,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { conversationsActive } from "@plugins/tasks/plugins/tasks-core/core";
import type { QueueRow } from "./use-queue-rows";

/**
 * The synthetic `section` field that drives the read-time partitioning — the
 * one field the Queue computes itself (`extraFields`); every other is derived
 * from its collection (`conversationsActive`: the conversations entity's
 * fields, the owners' columns and every exposed field of the task it reaches).
 */
export const QUEUE_EXTRA_FIELDS: FieldDef<QueueRow>[] = [
  {
    id: "section",
    label: "Section",
    type: "enum",
    value: (r) => r.section,
    groupable: true,
    filterable: false,
    options: [
      { value: "pinned", label: "Pinned" },
      { value: "queued", label: "Queue" },
      { value: "working", label: "Working" },
      { value: "lost", label: "Lost" },
      { value: "unranked", label: "Unranked" },
      { value: "disconnected", label: "Disconnected" },
      { value: "done", label: "Done" },
    ],
  },
];

/**
 * The conversation fields, forced non-groupable so the gear's group-by picker
 * offers only `section` (and the exposed fields, a task's track) + `None`.
 */
export const QUEUE_OVERRIDES = fieldOverrides(conversationsActive, {
  title: { groupable: false },
  status: { groupable: false },
  model: { groupable: false },
  kind: { groupable: false },
  runtime: { groupable: false },
  createdAt: { groupable: false },
  updatedAt: { groupable: false },
  endedAt: { groupable: false },
  worktreePath: { groupable: false },
  taskTitle: { groupable: false },
});
