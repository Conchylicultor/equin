import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { pluginReviewIdKind } from "./id-kind";

// One recorded plugin-health review, keyed by (pluginId, axis). The table (its
// `_pluginHealthReviews` pgTable) and this wire schema both derive from this
// single field record, so `$inferSelect ≡ PluginHealthReview` by construction —
// the loader returns `db.select()` rows verbatim, no projection.
export const pluginHealthReviewFields = {
  id: idKindField(pluginReviewIdKind),
  pluginId: textField({ label: "Plugin" }),
  axis: textField({ label: "Axis" }),
  commitHash: textField(),
  conversationId: nullable(textField()),
  createdAt: dateField(),
} satisfies FieldsRecord;

export const PluginHealthReviewSchema = fieldsToZodObject(
  pluginHealthReviewFields,
);
export type PluginHealthReview = z.infer<typeof PluginHealthReviewSchema>;

export const PluginStalenessSchema = z.object({
  axis: z.string(),
  commitsSince: z.number(),
  apiChanged: z.boolean(),
});
export type PluginStaleness = z.infer<typeof PluginStalenessSchema>;

export const ReviewTaskSummarySchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: z.string(),
});
export type ReviewTaskSummary = z.infer<typeof ReviewTaskSummarySchema>;
