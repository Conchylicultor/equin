import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { recheckClaudeCode } from "../core";
import { handleRecheck } from "./internal/handle-recheck";
import { claudeCodeStatusServed } from "./internal/status-served";

export default {
  description:
    "Claude Code availability, desktop-only half: serves the claude-code-status push value (the server half's last probe answer, pushed whenever it changes) and POST /api/claude-code/recheck — both declared needsMachine, so a host without the computer answers them unavailable.",
  httpRoutes: {
    [recheckClaudeCode.route]: handleRecheck,
  },
  contributions: [...claudeCodeStatusServed.declare],
} satisfies MachinePluginDefinition;
