import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { RestartSkip } from "./internal/kinds";
export type { AdoptHook } from "./internal/kinds";

export default {
  description:
    "Restart-skip's contribution kinds, a leaf every contributor imports (so contributing never pulls in the judgement and its imports): RestartSkip.BootInput (files a backend reads once and holds — a restart may be skipped only while they are untouched since it started) and RestartSkip.Adopted (what a backend re-reads when it adopts a deploy instead of being restarted: its commit pin, the web graph it judges tabs against). The judgement and the endpoint are restart-skip's machine half.",
} satisfies ServerPluginDefinition;
