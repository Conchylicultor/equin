import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Fields } from "@plugins/fields/web";
import { durationIdentity } from "../core";

export default {
  description:
    "Duration field type: identity only, extends number — a span in milliseconds, drawn compact (`850ms`, `4.2s`, `1m 04s`, `2h 05m`) and filtered by operands typed in units (`30s`, `5m`); sort and grouping inherited from number.",
  contributions: [Fields.Identity({ identity: durationIdentity })],
} satisfies PluginDefinition;
