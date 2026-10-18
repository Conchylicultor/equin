import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { liveMapSetupPane } from "../panes";

/**
 * Shown on a map whose stored Map ID Google drew as a RASTER map (a Map ID of
 * the wrong type, from another project, or deleted): the smooth zoom the user
 * set up is not happening, and saying so beats a silent fallback. Opens the
 * Live map setup, whose Map ID step shows the same finding.
 */
export function MapIdRasterNotice(): ReactElement {
  const openPane = useOpenPane();
  return (
    <Button
      variant="outline"
      {...openPane.link(liveMapSetupPane, {}, { mode: "root" })}
    >
      Map ID isn't a vector map — fix in setup
    </Button>
  );
}
