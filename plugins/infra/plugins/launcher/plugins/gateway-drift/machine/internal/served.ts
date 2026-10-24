import { serveValue } from "@plugins/network/plugins/live/machine";
import { gatewayDrift } from "../../core";
import { currentGatewayDrift, onGatewayDriftChanged } from "./state";

// External, not DB-backed: the truth is the service manager's definition, the
// binaries and the running gateway, which no change feed observes — so a check
// whose answer moved tells this value, for as long as some tab reads it.
// Pushed (the `liveValue` default): one small value, the same for every tab,
// read by the always-mounted health dot.
export const gatewayDriftServed = serveValue(gatewayDrift, {
  source: "external",
  changes: "notified",
  loader: () => currentGatewayDrift(),
  whileSubscribed: (_params, notify) => onGatewayDriftChanged(() => notify()),
});
