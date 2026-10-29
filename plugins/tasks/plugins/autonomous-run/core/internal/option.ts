import { z } from "zod";
import { defineLaunchOption } from "@plugins/tasks/plugins/launch-options/core";

/**
 * Whether the task starts an autonomous run. `null` = an ordinary
 * (interactive) task — the unset state, so the pill rests as its icon.
 */
export const autonomousLaunchOption = defineLaunchOption<true | null>({
  id: "autonomous",
  schema: z.literal(true).nullable(),
  defaultValue: null,
});
