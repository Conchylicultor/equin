// When a page of the deployed app is ready to capture — ONE readiness rule for
// the e2e harness (its scripts import it from here) and the agent browser's
// host (`infra/mcp/browser`'s `capturePair`), which may import no `e2e`
// barrel. Its own plugin, not the harness's `core/`: that barrel is read by
// the harness's lint rules, which must stay free of what this reaches.
export { waitForScreenReady } from "./internal/screen-ready";
export type { ScreenReadiness } from "./internal/screen-ready";
export { flatness, hexColor } from "./internal/flatness";
export type { Flatness, Rgba } from "./internal/flatness";
export {
  inflightUrls,
  trackContextNetwork,
  trackPageNetwork,
  waitForNetworkIdle,
} from "./internal/network-idle";
export type { NetworkIdleOptions } from "./internal/network-idle";
export { busyRegions, waitForNotBusy } from "./internal/busy";
export { waitFor, ELEMENT_TIMEOUT_MS } from "./internal/wait";
export type { Settled } from "./internal/wait";
