import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { taskShortTitleShape } from "../core";

export default {
  description:
    "Presents a task's Haiku-made short title (at most three words) and the full title it was made from, exposed on every list whose rows reach a task; a row's short title is current only while its source title equals the task's title (read through taskShortTitleColumns).",
  contributions: [
    // Fields of every list reaching a task; the source title is what a reader
    // checks the short one against, never something to show.
    FieldPresentation.Register({
      owner: taskShortTitleShape.exposure,
      fields: { sourceTitle: { visible: false } },
    }),
  ],
} satisfies PluginDefinition;
