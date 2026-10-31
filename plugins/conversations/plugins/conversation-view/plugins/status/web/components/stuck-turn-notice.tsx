import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

/**
 * The transcript foot of a stuck conversation (`waitingFor` `stuck-turn`): its
 * agent is alive and at rest but never started a message it was handed — not
 * the generic "waiting for your input", which would say the next move is the
 * user's message.
 */
export function StuckTurnNotice() {
  return (
    <Stack direction="row" align="center" gap="sm" className="px-xs py-xs">
      <Text as="span" variant="caption" className="text-warning/70">
        Stuck — the agent holds a message it never started
      </Text>
    </Stack>
  );
}
