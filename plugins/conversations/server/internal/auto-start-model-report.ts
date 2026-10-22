import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  choiceLabel,
  selectableChoices,
  unavailableMessage,
  type ModelCatalog,
  type ModelResolution,
} from "@plugins/conversations/plugins/model-provider/core";

const AutoStartModelUnavailablePayloadSchema = z.object({
  taskId: z.string(),
  choice: z.string(),
  /** The choice's label ("Opus 4.6"), as shown when it was refused. */
  label: z.string(),
  reason: z.enum(["retired", "unknown"]),
  message: z.string(),
});
type AutoStartModelUnavailablePayload = z.infer<
  typeof AutoStartModelUnavailablePayloadSchema
>;

/**
 * The `auto-start-model-unavailable` report kind: **an armed task names a
 * model version this machine can no longer run** (retired since it was armed,
 * or never known here). The queue refuses to launch it — never a silent
 * substitute — and leaves the task armed, so re-picking a model on the task
 * launches it. One row per task; its queued chip says the same thing.
 */
export const autoStartModelUnavailableKind = ReportKind({
  kind: "auto-start-model-unavailable",
  schema: AutoStartModelUnavailablePayloadSchema,
  fingerprint: (d: AutoStartModelUnavailablePayload) =>
    `auto-start-model-unavailable:${d.taskId}`,
  meta: {
    tag: "[auto-start]",
    notif: "A queued task's model is unavailable",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = AutoStartModelUnavailablePayloadSchema.parse(row.data);
    return {
      title: `[auto-start] Queued task cannot launch: ${d.label} is ${d.reason}`,
      description: [
        `Task \`${d.taskId}\` is armed to auto-start with a model version this ` +
          `machine cannot run, so the queue did not launch it:`,
        "",
        `> ${d.message}`,
        "",
        "It stays armed. Pick another model in the task's Prompt card (or " +
          "cancel the auto-start) and it launches as soon as nothing blocks it.",
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});

/** File (or bump) the task's report: its armed model cannot run. */
export async function reportAutoStartModelUnavailable(
  taskId: string,
  resolution: Extract<ModelResolution, { ok: false }>,
  catalog: ModelCatalog,
): Promise<void> {
  const message = unavailableMessage(resolution, selectableChoices(catalog));
  await recordReport({
    kind: "auto-start-model-unavailable",
    source: "server-caught",
    message: `${taskId}: ${message}`,
    data: {
      taskId,
      choice: resolution.choice,
      label: choiceLabel(resolution.choice),
      reason: resolution.reason,
      message,
    },
  });
}
