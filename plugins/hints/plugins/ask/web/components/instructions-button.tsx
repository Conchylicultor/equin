import { ForAudience } from "@plugins/audience/plugins/developer-mark/web";
import { useConfigLink } from "@plugins/config_v2/plugins/config-link/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { askConfig } from "../../core";

const instructionsIcon = symbol("tune");

/**
 * Developer-only header action of the card, empty or holding a thread: opens
 * the Ask equin config (Settings → Config), whose Instructions field is the
 * help agent's whole prompt — tune it there, then port the edit back to the
 * code default.
 */
export function AgentInstructionsButton() {
  return (
    <ForAudience audience="developer" mark="badge">
      <InstructionsButton />
    </ForAudience>
  );
}

function InstructionsButton() {
  const configLink = useConfigLink();
  return (
    <IconButton
      icon={instructionsIcon}
      label="Agent instructions"
      {...activationProps(configLink(askConfig))}
    />
  );
}
