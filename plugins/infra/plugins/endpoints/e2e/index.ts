/**
 * e2e barrel: a route as a string, for scripts that drive the deployed app
 * (`pageFetch` / `agentFetch` take a path). Never on a page — there an element
 * loads an `AssetPath` and a request goes through the subtree's transport.
 */
export { endpointPath } from "../core/request";
