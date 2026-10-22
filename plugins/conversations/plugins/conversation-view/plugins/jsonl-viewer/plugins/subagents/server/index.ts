import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { parentFactsServed } from "./internal/served";

export default {
  portable: true,
  description:
    "The reads behind the two live values the machine half serves: what every sub-agent is doing right now (one bounded tail read per change), and one sub-agent's own transcript, parsed by the same reader as the main conversation; it serves the parent-transcript facts sub-agent state joins on (Agent / Workflow calls, task notifications, idle and resume times), folded over the whole parent transcript.",
  contributions: [...parentFactsServed.declare],
} satisfies ServerPluginDefinition;
