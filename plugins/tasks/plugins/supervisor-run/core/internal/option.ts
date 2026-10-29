import { z } from "zod";
import { defineLaunchOption } from "@plugins/tasks/plugins/launch-options/core";

/**
 * Whether the task is a supervisor's root. `null` = an ordinary
 * (interactive) task — the unset state, so the pill rests as its icon.
 */
export const supervisorLaunchOption = defineLaunchOption<true | null>({
  id: "supervisor",
  schema: z.literal(true).nullable(),
  defaultValue: null,
});
