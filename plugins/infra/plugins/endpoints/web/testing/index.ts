// A recording fake of the transport-bound endpoint fetcher, and the provider
// mount that hands it to every endpoint client in a rendered tree.
export { fakeFetchEndpoint, withTransport } from "./fake-fetch-endpoint";
export type {
  FakeEndpointAnswer,
  FakeFetchEndpoint,
  FakeFetchEndpointOptions,
  FetchEndpointCall,
} from "./fake-fetch-endpoint";
