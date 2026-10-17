import type { HoverCardContent } from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";
import {
  WORKSPACE_CAPABILITIES,
  type WorkspaceChoice,
} from "@plugins/conversations/plugins/workspace/core";

/**
 * The hover card beside a workspace's menu row: what it is, every capability
 * with the ones the agent does not get there struck out, why it cannot be
 * picked (if so), and — for a scratch profile — which plugin provides it and
 * how many tools the agent sees.
 */
export function workspaceCard(choice: WorkspaceChoice): HoverCardContent {
  const profile = choice.profile;
  return {
    title: choice.label,
    code: profile?.id,
    description: choice.description,
    chips: WORKSPACE_CAPABILITIES.map((c) => ({
      label: c.label,
      off: !choice.capabilities.includes(c.id),
    })),
    notice: choice.unavailable,
    meta: profile
      ? [
          ...(profile.owner != null ? [profile.owner] : []),
          `${profile.mcpToolCount} MCP tools`,
        ]
      : undefined,
  };
}
