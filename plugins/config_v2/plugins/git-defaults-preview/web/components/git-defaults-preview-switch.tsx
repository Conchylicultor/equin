import { useAudience } from "@plugins/audience/web";
import { DeveloperMark } from "@plugins/audience/plugins/developer-mark/web";
import { setConfigPreview, useConfigPreview } from "@plugins/config_v2/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const previewIcon = symbol("visibility");

/**
 * The git-defaults preview switch, as a row of the view-options popover.
 * Developer-only — but shown whenever the preview is ON, whoever the user is:
 * the preview reads the committed Developer mode too (a new user's is off), and
 * the switch that turned it on must stay reachable to turn it off. That is why
 * it gates itself rather than declaring `audience: "developer"`, so it also
 * draws the developer mark itself (the host marks only what it gates).
 */
export function GitDefaultsPreviewSwitch() {
  const preview = useConfigPreview();
  const audience = useAudience();
  if (!preview) {
    // The popover's error boundary shows it: the row cannot claim to be absent.
    if (audience.status === "error") throw audience.error;
    if (audience.status === "loading") return <Loading variant="rows" />;
    if (audience.data !== "developer") return null;
  }
  return (
    <ControlPanel.LabelMark mark={<DeveloperMark />}>
      <ControlPanel.Row
      icon={<Icon icon={previewIcon} />}
      select="switch"
      checked={preview}
      onSelect={() => setConfigPreview(!preview)}
    >
        Preview default config
      </ControlPanel.Row>
    </ControlPanel.LabelMark>
  );
}
