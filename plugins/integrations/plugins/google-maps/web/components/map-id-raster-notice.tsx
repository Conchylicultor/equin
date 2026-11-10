import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useMachineAvailability } from "@plugins/infra/plugins/endpoints/web";
import { setMapsMapId } from "@plugins/integrations/plugins/google-maps/plugins/browser-config/core";
import { accountPane } from "@plugins/auth/web";
import { LIVE_MAP_ACCOUNT_ID } from "../internal/live-map-account";

/**
 * Shown on a map whose stored Map ID Google drew as a RASTER map (a Map ID of
 * the wrong type, from another project, or deleted): the smooth zoom the user
 * set up is not happening, and saying so beats a silent fallback. Opens the
 * Live map setup, whose Map ID step shows the same finding. Nothing where the
 * Map ID cannot be changed (a host without the computer — the demo draws with
 * its page's config): a fix the viewer cannot make is no affordance.
 */
export function MapIdRasterNotice(): ReactElement | null {
  const openPane = useOpenPane();
  const fixable = useMachineAvailability(setMapsMapId);
  if (!fixable.available) return null;
  return (
    <Button
      variant="outline"
      {...openPane.link(
        accountPane,
        { accountId: LIVE_MAP_ACCOUNT_ID },
        { mode: "root" },
      )}
    >
      Map ID isn't a vector map — fix in setup
    </Button>
  );
}
