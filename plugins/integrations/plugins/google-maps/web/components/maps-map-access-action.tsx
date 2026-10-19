import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useMapsAccess } from "../internal/use-maps-access";
import { accountPane } from "@plugins/auth/web";
import { LIVE_MAP_ACCOUNT_ID } from "../internal/live-map-account";

/**
 * The "set up the live map" affordance for the `"map"` capability: opens the
 * Live map setup pane (browser key). The map's only prerequisite is
 * the browser key — the Places key is irrelevant to drawing a map — so this
 * never routes to the Places wizard.
 *
 * Renders `null` when the map is ready or its config is still loading, so a
 * caller can drop it in unconditionally; a failed config read renders the
 * failure with Retry.
 */
export function MapsMapAccessAction(): ReactElement | null {
  const { blocker, loading, error, refetch } = useMapsAccess("map");
  const openPane = useOpenPane();

  if (loading) return null;
  if (error !== null)
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the live map setup state"
        error={error}
        refetch={refetch}
      />
    );
  if (blocker === null) return null;

  return (
    <Button
      variant="outline"
      {...openPane.link(
        accountPane,
        { accountId: LIVE_MAP_ACCOUNT_ID },
        { mode: "root" },
      )}
    >
      Set up the live map
    </Button>
  );
}
