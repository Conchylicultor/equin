import { openLink } from "@plugins/menu-bar/core";
import { inAppWindow } from "@plugins/menu-bar/plugins/app-window/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/**
 * A desktop whose helper handles `equin://`: macOS (`equin.app` declares it)
 * and desktop Linux (`dev.equin.open-link.desktop`) — not Android or ChromeOS,
 * whose user agents also say Linux.
 */
const handlesLinks =
  typeof navigator !== "undefined" &&
  /mac|linux/i.test(navigator.userAgent) &&
  !/android|cros/i.test(navigator.userAgent);

/**
 * Hand this page to the helper: the browser asks once whether to open equin,
 * then the OS delivers the link (macOS: to the running tray; Linux: to
 * `equin-desktop open-link`). Read at click time, so
 * the page is the one shown now.
 */
function openInWindow() {
  window.location.href = openLink(window.location.href);
}

/**
 * "Open in app window" in the view-options popover: this tab's page in the
 * installed app's own window — a new one, never replacing what another shows.
 * Absent inside an app window (it already is one) and where no helper handles
 * the link.
 */
export function OpenInWindowRow() {
  if (!handlesLinks || inAppWindow()) return null;
  return (
    <ControlPanel.Row
      icon={<Icon icon={navIcons.hostApp} />}
      onSelect={openInWindow}
    >
      Open in app window
    </ControlPanel.Row>
  );
}
