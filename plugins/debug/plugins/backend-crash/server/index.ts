import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { backendCrashKind } from "./internal/backend-crash-kind";

export default {
  description:
    "The backend-crash report kind — filed by the gateway through the report outbox when a backend (central included) dies by a signal it did not send, drained by main: the signal, uptime, Bun's panic line and bun.report link, the macOS crash report's location and the dead process's last stderr lines. Main's own crash is filed by the next main backend.",
  contributions: [backendCrashKind],
} satisfies ServerPluginDefinition;
