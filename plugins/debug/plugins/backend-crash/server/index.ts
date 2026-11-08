import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { backendCrashKind } from "./internal/backend-crash-kind";
import { backendCrashLoopKind } from "./internal/backend-crash-loop-kind";
import { backendExitKind } from "./internal/backend-exit-kind";

export default {
  description:
    "The backend death report kinds, filed by the gateway through the report outbox for every backend (central and main included) death it did not cause, drained by main: backend-crash (a signal it did not send — the signal, Bun's panic line and bun.report link, the macOS crash report's location), backend-exit (an exit code nobody asked for — the code, whether it died booting or serving) and backend-crash-loop (a worktree that keeps dying: the deaths, their causes, the last one's stderr), each with the dead process's last stderr lines. Main's own deaths are filed by the next main backend that lives long enough to drain the outbox.",
  contributions: [backendCrashKind, backendExitKind, backendCrashLoopKind],
} satisfies ServerPluginDefinition;
