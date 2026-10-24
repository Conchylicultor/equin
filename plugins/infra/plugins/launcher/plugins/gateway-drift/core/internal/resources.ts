import { liveValue } from "@plugins/network/plugins/live/core";
import { GatewayDriftSchema } from "./drift";

/**
 * The machine's gateway against what `./equin start --force` would install
 * now, pushed whenever the answer changes. A schema-bounded scalar. No
 * placeholder: until the first check lands, `useLive` reports it pending. It
 * reads the computer's service manager and binaries (`needsMachine`): a reader
 * under an in-browser server gets `unavailable`.
 */
export const gatewayDrift = liveValue("gateway-drift", {
  schema: GatewayDriftSchema,
  needsMachine: { feature: "Checking the gateway" },
});
