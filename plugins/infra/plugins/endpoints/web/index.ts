import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  fetchEndpointOver,
  useFetchEndpoint,
  getEndpointErrorMessage,
} from "./internal/fetch-endpoint";
export { EndpointError, EndpointAgentWriteRefusedError } from "../core";
export type { FetchEndpoint } from "./internal/fetch-endpoint";
export { useEndpointMutation } from "./internal/use-endpoint-mutation";
export { useMachineAvailability } from "./internal/use-machine-availability";
export { useAssetSrc, useAssetSrcs } from "./internal/asset-src";
export type { AssetSrc } from "./internal/asset-src";
export { assetUrlOver, useAssetUrl } from "./internal/asset-url";
export type { AssetUrl } from "./internal/asset-url";
export { endpointErrorSink } from "./internal/error-reporter";
export type { EndpointErrorInfo } from "./internal/error-reporter";

export default {
  description:
    "Typed endpoint contract primitive. useFetchEndpoint (a FetchEndpoint bound to the subtree's transport; fetchEndpointOver(t) for sanctioned page-level code) and useEndpointMutation consume endpoint definitions on the client — writes, and requests that are not reads a surface renders (every server read is a live resource, read with useLive); useAssetSrc turns an AssetPath (a GET endpoint's asset) into what an element loads over the subtree's transport (the path, a blob URL, or unavailable); useAssetUrl / assetUrlOver hand a sink that loads by URL on its own (a library's fetch, an HTML string, an iframe) an AssetPath's or AssetBase's URL, or unavailable.",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
