import { openLink } from "@plugins/menu-bar/core";
import { inAppWindow } from "@plugins/menu-bar/plugins/app-window/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/** macOS: the only platform whose equin app registers `equin://`. */
const onMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

/**
 * Hand this page to the helper: the browser asks once whether to open equin,
 * then macOS delivers the link to the running tray. Read at click time, so
 * the page is the one shown now.
 */
function openInWindow() {
  window.location.href = openLink(window.location.href);
}

/**
 * "Open in app window" in the view-options popover: this tab's page in the
 * installed app's own window. Absent inside an app window (it already is one)
 * and off macOS.
 */
export function OpenInWindowRow() {
  if (!onMac || inAppWindow()) return null;
  return (
    <ControlPanel.Row
      icon={<Icon icon={navIcons.hostApp} />}
      onSelect={openInWindow}
    >
      Open in app window
    </ControlPanel.Row>
  );
}
