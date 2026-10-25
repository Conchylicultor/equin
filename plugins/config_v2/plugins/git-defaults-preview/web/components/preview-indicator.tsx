import { useEffect } from "react";
import {
  onConfigWriteRefused,
  setConfigPreview,
  useConfigPreview,
} from "@plugins/config_v2/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const previewIcon = symbol("visibility");

/**
 * The action bar's mark that this tab previews the git defaults — nothing
 * while it does not — and a click turns the preview off. Mounted with the bar
 * on every app, it is also what says why a config change did nothing.
 */
export function PreviewIndicator() {
  const preview = useConfigPreview();
  useEffect(
    () =>
      onConfigWriteRefused(() =>
        showToast({
          variant: "error",
          title: "Config is read-only while previewing the default config",
          description: "Turn the preview off to change it.",
        }),
      ),
    [],
  );
  if (!preview) return null;
  return (
    <IconButton
      icon={previewIcon}
      active
      variant="secondary"
      label="Previewing the default config — click to exit"
      onClick={() => setConfigPreview(false)}
    />
  );
}
