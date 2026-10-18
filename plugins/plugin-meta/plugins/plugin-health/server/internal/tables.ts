import { uniqueIndex } from "drizzle-orm/pg-core";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { pluginHealthReviewsEntityRef } from "../../core";

// The table + the `PluginHealthReview` wire schema both derive from the single
// `pluginHealthReviewFields` record (core), so a column/schema drift is
// unrepresentable and the reviews collection binds every row field to its
// column by name.
const pluginHealthReviews = defineEntity(pluginHealthReviewsEntityRef, {
  primaryKey: "id",
  columns: {
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [
    uniqueIndex("plugin_health_reviews_plugin_axis_idx").on(t.pluginId, t.axis),
  ],
});

// drizzle-kit schema-glob discovery. Name kept so consumers don't churn.
export const _pluginHealthReviews = pluginHealthReviews.table;

// Which tasks belong to a review. The `review_id` index serves the only read
// keyed on a foreign column — `handleGetTasksForReview` (see ./routes.ts),
// `WHERE review_id = X` joined to `_tasks` on the `taskId` key (`parent_id`);
// the pk's implicit btree covers the join side, not the filter. The row never
// reaches the browser, so the shape is declared here rather than in `shared/`.
const healthReviewShape = defineExtensionShape({
  key: "taskId",
  fields: { reviewId: textField() },
});
export const healthReviewExt = defineExtension(
  _tasks,
  "health_review",
  healthReviewShape,
  {
    indexes: (t, b) => [b.index("review_id").on(t.reviewId)],
  },
);
export const _tasksExtHealthReview = healthReviewExt.table;
