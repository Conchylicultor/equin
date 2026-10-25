import { useAudience } from "@plugins/audience/web";
import {
  DeveloperMark,
  ForAudience,
} from "@plugins/audience/plugins/developer-mark/web";
import { useConfigLink } from "@plugins/config_v2/plugins/config-link/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { askConfig } from "../../core";

const instructionsIcon = symbol("tune");
const LABEL = "Agent instructions";

/** Opens the Ask equin config, whose Instructions field is the agent's prompt. */
function useOpenInstructions() {
  const configLink = useConfigLink();
  return activationProps(configLink(askConfig));
}

/**
 * Developer-only, under the suggestions of the empty card: opens the Ask equin
 * config (Settings → Config), whose Instructions field is the help agent's
 * whole prompt — tune it there, then port the edit back to the code default.
 */
export function AgentInstructionsRow() {
  // Gated by hand, not ForAudience: its mark sits inside the row, after the
  // label, which none of ForAudience's mark forms draws.
  const audience = useAudience();
  if (audience.status === "error") throw audience.error;
  if (audience.status === "loading") return null;
  return audience.data === "developer" ? <InstructionsRow /> : null;
}

function InstructionsRow() {
  const open = useOpenInstructions();
  return (
    <div className="border-t border-border pt-xs">
      <Line
        as="button"
        type="button"
        aria-label={LABEL}
        {...open}
        className={cn(
          hoverRevealGroup,
          "w-full gap-xs rounded-md px-sm py-xs text-left text-muted-foreground hover:bg-hover-fill hover:text-foreground",
        )}
      >
        <Icon icon={instructionsIcon} className="size-4" />
        <Text variant="caption">{LABEL}</Text>
        <DeveloperMark />
        <Icon
          icon={navIcons.expand}
          className={cn("ml-auto size-3.5", hoverRevealTarget)}
        />
      </Line>
    </div>
  );
}

/**
 * The same, developer-only, as a header action of a card holding a thread —
 * the suggestions are gone once a question was asked.
 */
export function AgentInstructionsButton() {
  return (
    <ForAudience audience="developer" mark="badge">
      <InstructionsButton />
    </ForAudience>
  );
}

function InstructionsButton() {
  const open = useOpenInstructions();
  return <IconButton icon={instructionsIcon} label={LABEL} {...open} />;
}
