import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { accountPane } from "@plugins/auth/web";
import { GOOGLE_MAPS_PROVIDER_ID } from "@plugins/auth/plugins/google-maps/core";
import {
  useMapsAccess,
  type MapsAccessBlocker,
} from "../internal/use-maps-access";

/** Human copy for each unmet prerequisite, so every Maps surface explains the
 *  same blocker the same way instead of inventing its own wording. */
export const MAPS_BLOCKER_BODY = {
  "not-configured":
    "Google Maps needs an API key before it can look up addresses.",
  "no-browser-key":
    "The live map needs a Google Maps browser key before it can draw.",
} as const satisfies Record<MapsAccessBlocker, string>;

/**
 * The "set up Google Maps" affordance for the `"places"` capability — the one
 * place that maps its unmet prerequisite to the control that resolves it, in
 * situ. The live map's twin is `MapsMapAccessAction`.
 *
 * Consumers (the `/place` block's empty state) render this rather than routing
 * the user to Settings to work it out for themselves — and they get the
 * affordance without importing `@plugins/auth`, which this integration exists to
 * broker on their behalf.
 *
 * Renders `null` when access is ready, so a caller can drop it in unconditionally;
 * a failed auth-state read renders the failure with Retry.
 */
export function MapsAccessAction(): ReactElement | null {
  const { blocker, loading, error, refetch } = useMapsAccess("places");
  const openPane = useOpenPane();

  if (loading) return null;
  // Whether a key is configured could not be read: offer the read's Retry,
  // never a guessed "Set up" (or nothing, as if all were well).
  if (error !== null)
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the Google Maps setup state"
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
        { accountId: GOOGLE_MAPS_PROVIDER_ID },
        { mode: "root" },
      )}
    >
      Set up Google Maps
    </Button>
  );
}
