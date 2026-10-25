import { ForAudience } from "@plugins/audience/plugins/developer-mark/web";
import { setConfigPreview, useConfigPreview } from "@plugins/config_v2/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const previewIcon = symbol("visibility");

/**
 * The git-defaults preview switch, as a row of the view-options popover.
 * Developer-only — but shown whenever the preview is ON, whoever the user is
 * (`shownWhile`): the preview reads the committed Developer mode too (a new
 * user's is off), and the switch that turned it on must stay reachable to turn
 * it off. That is why it gates itself rather than declaring `audience` on its
 * contribution: the host cannot see the preview.
 */
export function GitDefaultsPreviewSwitch() {
  const preview = useConfigPreview();
  return (
    <ForAudience audience="developer" mark="label" shownWhile={preview}>
      <ControlPanel.Row
        icon={<Icon icon={previewIcon} />}
        select="switch"
        checked={preview}
        onSelect={() => setConfigPreview(!preview)}
      >
        Preview default config
      </ControlPanel.Row>
    </ForAudience>
  );
}
