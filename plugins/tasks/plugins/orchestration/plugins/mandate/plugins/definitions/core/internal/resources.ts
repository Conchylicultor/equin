import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/**
 * Every named mandate the code defines (`Mandate.Definition`): its id and
 * label — the options of the `mandate` field every task list shows. Fixed for
 * the process (contributions register at boot), hydrated before first paint.
 */
export const MandateDefinitionsSchema = wholeList(
  z.object({ id: z.string(), label: z.string() }),
  {
    reason:
      "one entry per named mandate the code defines — the presets and one per automation, a handful",
  },
);
export type MandateDefinitions = z.infer<typeof MandateDefinitionsSchema>;

export const mandateDefinitions = liveValue("mandate.definitions", {
  schema: MandateDefinitionsSchema,
  preload: "boot-and-keep",
});
