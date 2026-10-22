import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
  type ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
import { deployment, type Carrier, type DeploymentState } from "../../core";
import { tabCarrier } from "./tab-carrier";

/**
 * What one client knows about the deployment: the server's verdict plus its
 * evidence, and the full carrier set — the server's two deployable pins with
 * THIS tab's own pin composed in beside them.
 *
 * A resource result rather than nullable fields, so a consumer cannot read
 * `state` before it exists, and a failed read is its own `error` arm (with the
 * typed `ResourceError` and a `refetch`) rather than a flavour of loading.
 * `unavailable`: the deployment is read with git off the computer
 * (`needsMachine`), and this subtree has none behind it (the demo).
 */
export type DeploymentReading =
  | ResourceResult<{
      state: DeploymentState;
      carriers: Carrier[];
    }>
  | ResourceUnavailable;

/**
 * The one client-side read of the deployment.
 *
 * It **composes**, it does not derive: `state.kind` is the server's own
 * `convergenceOf` verdict, shipped as the payload's discriminant, so the badge
 * a user reads and the decision the auto-build reconciler makes are the same
 * function of the same git snapshot. Re-deriving the arm here is exactly the
 * split-brain this design exists to remove.
 *
 * The one thing it adds is the `tab` carrier, which is not a derivation either
 * — it is a fact only this tab holds.
 */
export function useDeployment(): DeploymentReading {
  const result = useLive(deployment);
  return mapResource(result, (state) => ({
    state,
    // Order matters only for reading: server, web, then this tab.
    carriers: [...state.deployable, tabCarrier()],
  }));
}
