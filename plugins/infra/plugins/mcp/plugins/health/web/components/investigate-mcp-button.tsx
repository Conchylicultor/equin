import { SYSTEM_CATEGORY_ID } from "@plugins/conversations/core";
import { mcpHealth } from "@plugins/infra/plugins/mcp/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { buildMcpInvestigatePrompt } from "../internal/investigate-prompt";

const autoAwesomeIcon = symbol("auto-awesome");

/**
 * The MCP server row's remedy (drawn only while it is failing or degraded):
 * the standard launch popover, listing what failed, launching an agent
 * briefed with it to find and fix the cause.
 */
export function InvestigateMcpButton() {
  const result = useLive(mcpHealth);
  // The row reads the same value: it is not failing (so this is not drawn)
  // until the value is ready, and an unreadable one makes the row unknown.
  if (result.status === "loading" || result.status === "error") return null;
  const health = result.data;
  const lines = [
    ...(health.requests.kind === "failing"
      ? [`Latest request: ${health.requests.message}`]
      : []),
    ...health.degraded.map((d) => `${d.what}: ${d.message}`),
  ];
  return (
    <LaunchAgentPopover
      draftKey="mcp-health:investigate"
      trigger={
        <Button variant="ghost">
          <Icon icon={autoAwesomeIcon} className="size-3.5" />
          Investigate
        </Button>
      }
      title="Investigate the MCP server"
      description={
        <Stack gap="2xs">
          {lines.map((line) => (
            <Text key={line} variant="caption">
              · {line}
            </Text>
          ))}
        </Stack>
      }
      placeholder="Extra context (optional)"
      align="end"
      getRequest={(userText) => ({
        prompt: buildMcpInvestigatePrompt(
          health,
          window.location.host,
          userText,
        ),
        categoryId: SYSTEM_CATEGORY_ID,
      })}
    />
  );
}
