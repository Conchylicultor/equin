import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  fetchEndpoint,
  useFetchEndpoint,
  EndpointError,
  EndpointUnsupportedError,
  getEndpointErrorMessage,
} from "./internal/fetch-endpoint";
export { useEndpoint } from "./internal/use-endpoint";
export { endpointQueryKey } from "./internal/query-key";
export { useEndpointMutation } from "./internal/use-endpoint-mutation";
export { useMachineAvailability } from "./internal/use-machine-availability";
export { endpointErrorSink } from "./internal/error-reporter";
export type { EndpointErrorInfo } from "./internal/error-reporter";

export default {
  description:
    "Typed endpoint contract primitive. fetchEndpoint, useEndpoint, and useEndpointMutation consume endpoint definitions on the client.",
  loadBearing: true,
  contributions: [],
} satisfies PluginDefinition;
