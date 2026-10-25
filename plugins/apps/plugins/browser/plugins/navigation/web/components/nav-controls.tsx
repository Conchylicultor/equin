import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useBrowserNav } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const arrowBackIcon = symbol("arrow-back");
const arrowForwardIcon = symbol("arrow-forward");
const refreshIcon = symbol("refresh");

/**
 * Back / forward / reload in the browser chrome bar. There is no Home button:
 * as in Chrome, a new tab is the start page.
 */
export function NavControls() {
  const { current, canGoBack, canGoForward, back, forward, reload } =
    useBrowserNav();
  return (
    <Stack direction="row" gap="2xs" align="center">
      <IconButton
        icon={arrowBackIcon}
        label="Back"
        tooltip="Back"
        onClick={back}
        disabled={!canGoBack}
      />
      <IconButton
        icon={arrowForwardIcon}
        label="Forward"
        tooltip="Forward"
        onClick={forward}
        disabled={!canGoForward}
      />
      <IconButton
        icon={refreshIcon}
        label="Reload"
        tooltip="Reload"
        onClick={reload}
        disabled={current === ""}
      />
    </Stack>
  );
}
