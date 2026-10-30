import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { freezeBackend } from "../shared/endpoints";
import { backendFrozenKind } from "./internal/frozen-kind";
import { handleFreeze } from "./internal/handle-freeze";

export default {
  description:
    "The backend-frozen report kind — filed by central's liveness probe through the report outbox, drained by main: every minute while a backend stays frozen, once when the episode ends (main's own freeze is filed as soon as its thread runs again). Plus a debug-only trigger that freezes a worktree backend's JS thread to reproduce it.",
  httpRoutes: {
    [freezeBackend.route]: handleFreeze,
  },
  contributions: [backendFrozenKind],
} satisfies ServerPluginDefinition;
