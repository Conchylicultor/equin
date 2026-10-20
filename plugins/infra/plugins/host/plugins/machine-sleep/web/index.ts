import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useSleepNow, useSleepNowForFold } from "./internal/use-sleep-now";

export default {
  description:
    "useSleepNow(): the machine.sleep live value (and useSleepNowForFold: the reading as op-log's `sleepNow` fold parameter, unknown while loading or where the computer cannot be read) — the box's sleep clock, so a live surface can count a nap as asleep rather than as work.",
} satisfies PluginDefinition;
