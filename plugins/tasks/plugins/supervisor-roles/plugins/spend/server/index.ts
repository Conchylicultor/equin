import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { supervisorsSpendServed } from "./internal/served";

export default {
  description:
    "The supervisors spend breakdown, server half: serves supervisors.spend — this week's Claude spend (each account over its own window, the browser's) as one drill tree: Supervisors (a role's sessions and workers), Ad hoc, Background (automations, background calls and system conversations such as triage), You (Claude Code sessions outside equin included) and Unknown (usage counted under no account, from the earliest window), each level its five biggest parts and a rest. One aggregate over the spend ledger joined to the conversation → attempt → task → mandate root → role / automation, recomputed on every ledger write.",
  contributions: [...supervisorsSpendServed.declare],
} satisfies ServerPluginDefinition;
