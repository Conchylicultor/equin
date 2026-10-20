import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { modelCatalogDir } from "../../data-dirs";

export const ModelUnrecognizedPayloadSchema = z.object({
  problem: z.enum([
    "unknown-alias",
    "not-a-model-id",
    "family-mismatch",
    "family-missing",
  ]),
  /** The menu entry's `value` — or, for `family-missing`, the family the menu left out. */
  value: z.string(),
  /** What the entry resolves to; null for `family-missing`. */
  resolvedModel: z.string().nullable(),
});
export type ModelUnrecognizedPayload = z.infer<
  typeof ModelUnrecognizedPayloadSchema
>;

const EXPLAIN: Record<ModelUnrecognizedPayload["problem"], string> = {
  "unknown-alias":
    "names an alias that is neither a family this code knows nor a Claude model name — the CLI added an alias, or a new family",
  "not-a-model-id":
    "resolves to a name outside the model id grammar (`claude-<family>-<major>[-<minor>]`) — the CLI changed its naming",
  "family-mismatch":
    "is a family alias that resolves to another family's model",
  "family-missing":
    "is a family this code knows that the menu does not list — the CLI dropped or renamed its alias",
};

/**
 * Something in the Claude CLI's model menu that discovery cannot place: an
 * alias it does not know, a model name outside the id grammar, or a family the
 * menu leaves out. Discovery never guesses: nothing in the catalog changes for
 * that entry (a missing family keeps its current version), and this says so.
 * One row per (problem, entry, resolved name).
 */
export const modelUnrecognizedKind = ReportKind({
  kind: "model-unrecognized",
  schema: ModelUnrecognizedPayloadSchema,
  fingerprint: (d: ModelUnrecognizedPayload) =>
    `model-unrecognized:${d.problem}:${d.value}:${d.resolvedModel ?? ""}`,
  meta: {
    tag: "[models]",
    notif: "The Claude CLI's model menu names something unrecognized",
    variant: "warning",
    // Discovery runs daily and on every CLI update, so a standing rename would
    // re-ring daily; once a day is the cadence the fact can change at.
    notifCooldownMs: 24 * 60 * 60 * 1000,
  },
  renderTask: (row: ReportRow) => {
    const d = ModelUnrecognizedPayloadSchema.parse(row.data);
    const entry =
      d.resolvedModel === null
        ? `\`${d.value}\``
        : `\`${d.value}\` (→ \`${d.resolvedModel}\`)`;
    return {
      title: `[models] Claude CLI model menu: ${d.value} unrecognized (${d.problem})`,
      description: [
        `Model discovery read the installed Claude CLI's model menu (the ` +
          `\`initialize\` control request) and the entry ${entry} ` +
          `${EXPLAIN[d.problem]}.`,
        "",
        `Nothing in the catalog changed for it (see ` +
          `\`${modelCatalogDir.file("catalog.json")}\`); nothing was guessed.`,
        "",
        `A new family is one \`FAMILY_META\` entry plus its \`MODEL_TIERS\` ` +
          `slot in \`plugins/conversations/plugins/model-provider/core/registry.ts\`; ` +
          `a naming change is a change to the id grammar beside it.`,
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
