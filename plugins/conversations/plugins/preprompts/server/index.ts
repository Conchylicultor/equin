import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
// Registers the configured icons' saved-icon source (module eval).
import "./internal/saved-icons";
import { ConfigV2 } from "@plugins/config_v2/server";
import { prepromptsConfig } from "../shared/config";

export { resolvePrepromptItem } from "./internal/resolve";

export default {
  description:
    "Library of named instruction snippets added to a task's agent system prompt, after Claude Code's own, as a <special_instructions> block.",
  contributions: [ConfigV2.Register({ descriptor: prepromptsConfig })],
  portable: true,
} satisfies ServerPluginDefinition;
