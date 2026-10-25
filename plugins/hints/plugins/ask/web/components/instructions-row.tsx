import { useAudience } from "@plugins/audience/web";
import { DeveloperMark } from "@plugins/audience/plugins/developer-mark/web";
import { useConfigLink } from "@plugins/config_v2/plugins/config-link/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { askConfig } from "../../core";

const instructionsIcon = symbol("tune");

/**
 * Developer-only, under the suggestions of the empty card: opens the Ask equin
 * config (Settings → Config), whose Instructions field is the help agent's
 * whole prompt — tune it there, then port the edit back to the code default.
 */
export function AgentInstructionsRow() {
  const audience = useAudience();
  const configLink = useConfigLink();
  if (audience.status === "error") throw audience.error;
  if (audience.status === "loading") return <Loading variant="rows" />;
  if (audience.data !== "developer") return null;
  return (
    <div className="border-t border-border pt-xs">
      <Line
        as="button"
        type="button"
        aria-label="Agent instructions"
        {...activationProps(configLink(askConfig))}
        className={cn(
          hoverRevealGroup,
          "w-full gap-xs rounded-md px-sm py-xs text-left text-muted-foreground hover:bg-hover-fill hover:text-foreground",
        )}
      >
        <Icon icon={instructionsIcon} className="size-4" />
        <Text variant="caption">Agent instructions</Text>
        <DeveloperMark />
        <Icon
          icon={navIcons.expand}
          className={cn("ml-auto size-3.5", hoverRevealTarget)}
        />
      </Line>
    </div>
  );
}
