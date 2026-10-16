import type { ReactElement } from "react";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { settingsApp } from "@plugins/apps/plugins/settings/plugins/shell/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { liveMapSetupPane } from "../panes";

/**
 * Shown on a map whose stored Map ID Google drew as a RASTER map (a Map ID of
 * the wrong type, from another project, or deleted): the smooth zoom the user
 * set up is not happening, and saying so beats a silent fallback. Opens the
 * Live map setup, whose Map ID step shows the same finding.
 */
export function MapIdRasterNotice(): ReactElement {
  return (
    <Button
      variant="outline"
      {...appLinkProps(liveMapSetupPane.link(settingsApp, {}))}
    >
      Map ID isn't a vector map — fix in setup
    </Button>
  );
}
