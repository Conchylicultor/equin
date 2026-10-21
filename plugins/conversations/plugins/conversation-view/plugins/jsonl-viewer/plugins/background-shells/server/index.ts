import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { factsServed } from "./internal/served";

export default {
  description:
    "Serves a conversation's background shells as its whole transcript records them (launch, command, output file, end), folded on every host from the transcript source; the live tail of a shell's output file is the machine half's.",
  contributions: [...factsServed.declare],
  portable: true,
} satisfies ServerPluginDefinition;
