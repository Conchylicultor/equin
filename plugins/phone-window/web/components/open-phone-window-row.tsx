import { deviceSize } from "@plugins/primitives/plugins/dom/plugins/device-sizes/core";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";

const phoneIcon = symbol("phone-iphone");

/**
 * The phone window's browsing-context name: one window, reused — opening it
 * again navigates the open one to this page rather than stacking another — and
 * how a page tells it is the phone window itself (`window.name` lives as long
 * as the window).
 */
const PHONE_WINDOW_NAME = "equin-phone";

const readIsPhoneWindow = (): boolean => window.name === PHONE_WINDOW_NAME;

/**
 * Open this page in the phone window. A `popup` window has no tab strip or
 * address bar, so Chrome lets it be as narrow as a phone (a normal window stops
 * at ~500px); `width`/`height` are its viewport, in CSS pixels. Read at click
 * time, so the page is the one shown now.
 */
function openPhoneWindow() {
  const { w, h } = deviceSize("Phone");
  const opened = window.open(
    window.location.href,
    PHONE_WINDOW_NAME,
    `popup,width=${w},height=${h}`,
  );
  if (opened === null)
    throw new Error("The browser blocked the phone window pop-up");
  opened.focus();
}

/**
 * "Open phone window" in the view-options popover: this page at phone size
 * (the Phone device size), in a pop-up window of the same browser — so the
 * session and sign-ins carry over, and the app's phone layout is the real one
 * a narrow window gets. Absent inside the phone window itself.
 */
export function OpenPhoneWindowRow() {
  // `window.name` is fixed for the window's lifetime: read once, no subscription.
  const isPhoneWindow = useBrowserValue({
    name: "window.name",
    read: readIsPhoneWindow,
    staticValue: false,
  });
  if (isPhoneWindow) return null;
  return (
    <ControlPanel.Row
      icon={<Icon icon={phoneIcon} />}
      onSelect={openPhoneWindow}
      hint="A phone-sized window of this page. Its size is real, but touch and hover are still the laptop's."
    >
      Open phone window
    </ControlPanel.Row>
  );
}
