import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  WORKSPACE_CAPABILITIES,
  type WorkspaceChoice,
} from "@plugins/conversations/plugins/workspace/core";

/**
 * The hover card beside a workspace's menu row: what it is, what the agent
 * gets there and what it does not, and — for a scratch profile — which plugin
 * provides it and how many tools the agent sees.
 */
export function WorkspaceInfo({ choice }: { choice: WorkspaceChoice }) {
  const has = WORKSPACE_CAPABILITIES.filter((c) =>
    choice.capabilities.includes(c.id),
  );
  const lacks = WORKSPACE_CAPABILITIES.filter(
    (c) => !choice.capabilities.includes(c.id),
  );
  const profile = choice.profile;
  return (
    <Stack gap="2xs" className="py-2xs">
      <Text variant="caption" className="font-medium">
        {profile ? `Scratch · ${choice.label}` : choice.label}
      </Text>
      <Text variant="caption" tone="muted">
        {choice.description}
      </Text>
      {has.length > 0 && (
        <Text variant="caption" tone="muted">
          Has {has.map((c) => c.label).join(", ")}.
        </Text>
      )}
      {lacks.length > 0 && (
        <Text variant="caption" tone="muted">
          No {lacks.map((c) => c.label).join(", ")}.
        </Text>
      )}
      {profile && (
        <Text variant="caption" tone="muted" className="font-mono">
          {[profile.id, profile.owner, `${profile.mcpToolCount} MCP tools`]
            .filter((part) => part != null)
            .join(" · ")}
        </Text>
      )}
      {choice.unavailable && (
        <Text variant="caption" tone="muted">
          {choice.unavailable}.
        </Text>
      )}
    </Stack>
  );
}
