import { SYSTEM_CATEGORY_ID } from "@plugins/conversations/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { LaunchAgentPopover } from "@plugins/primitives/plugins/launch/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { gatewayDrift } from "../../core";
import { buildGatewayUpdatePrompt } from "../internal/update-prompt";

const autoAwesomeIcon = symbol("auto-awesome");

/**
 * The Gateway row's remedy (drawn only while it is out of date): the standard
 * launch popover, the differences written out as the agent's first turn, so
 * the row itself stays one line. The agent runs `./equin start --force`.
 */
export function UpdateGatewayButton() {
  const result = useLive(gatewayDrift);
  const differences =
    result.status === "ready" && result.data.kind === "stale"
      ? result.data.differences
      : [];
  return (
    <LaunchAgentPopover
      draftKey="gateway-drift:update"
      trigger={
        <Button variant="ghost">
          <Icon icon={autoAwesomeIcon} className="size-3.5" />
          Update
        </Button>
      }
      title="Update the gateway"
      description={
        <Stack gap="2xs">
          {differences.map((d) => (
            <Text key={d} variant="caption">
              · {d}
            </Text>
          ))}
        </Stack>
      }
      placeholder="Extra context (optional)"
      align="end"
      getRequest={(userText) => ({
        prompt: buildGatewayUpdatePrompt(differences, userText),
        categoryId: SYSTEM_CATEGORY_ID,
      })}
    />
  );
}
