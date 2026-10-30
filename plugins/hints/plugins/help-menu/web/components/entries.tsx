import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { openInBrowserTab } from "@plugins/primitives/plugins/link-gesture/web";
import { NewTabGlyph } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  startTour,
  useHints,
  useResetHints,
  useTours,
} from "@plugins/hints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useCloseHelpMenu } from "../internal/close-menu";

const replayIcon = symbol("replay");
const lightbulbIcon = symbol("lightbulb");
const guideIcon = symbol("menu-book");

const GUIDE_URL = "https://equin.ai/website/guide";

/**
 * Starts the primary tour (`defineTour({ primary: true })`) — the engine
 * navigates to its app first. Absent when no plugin declares one.
 */
export function ReplayTourEntry() {
  const close = useCloseHelpMenu();
  const primary = useTours().find((t) => t.primary);
  if (!primary) return null;
  return (
    <ControlPanel.Row
      icon={<Icon icon={replayIcon} />}
      onSelect={() => {
        close();
        startTour(primary.id);
      }}
    >
      Replay the tour
    </ControlPanel.Row>
  );
}

/** Forgets every declared tip's seen row, so each shows again at its moment. */
export function ShowTipsAgainEntry() {
  const close = useCloseHelpMenu();
  const hints = useHints();
  const resetHints = useResetHints();
  return (
    <ControlPanel.Row
      icon={<Icon icon={lightbulbIcon} />}
      disabled={hints.length === 0}
      onSelect={() => {
        close();
        // A failed reset rejects unhandled, which the reports plugin files;
        // the toast only follows a reset that landed.
        void resetHints(hints.map((h) => h.id)).then(() =>
          showToast({
            title: "Tips are back on",
            description: "They'll show again as you go.",
          }),
        );
      }}
    >
      Show tips again
    </ControlPanel.Row>
  );
}

/** Opens the equin guide on the website, in a new browser tab. */
export function ReadGuideEntry() {
  const close = useCloseHelpMenu();
  return (
    <ControlPanel.Row
      icon={<Icon icon={guideIcon} />}
      trailing={<NewTabGlyph />}
      onSelect={() => {
        openInBrowserTab(GUIDE_URL);
        close();
      }}
    >
      Read the guide
    </ControlPanel.Row>
  );
}
