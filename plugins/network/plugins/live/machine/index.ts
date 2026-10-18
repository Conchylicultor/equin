import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { serveCollection, serveValue } from "./internal/serve";

export default {
  description:
    "Unified live-resource API, desktop-only half: serveValue and serveCollection for a liveValue / liveCollection declared needsMachine — the same overloads and code as the server half's, which refuse such a declaration (tsc).",
} satisfies MachinePluginDefinition;
