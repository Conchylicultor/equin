// Leaf by contract: string literals and one `Request` header read. Never add a
// `node:*` import or a db edge here — the `e2e` runtime and browser-reachable
// code both import this barrel, and either would break them at module eval.
export {
  ORIGIN_HEADER,
  ORIGIN_SOURCE_HEADER,
  AGENT_ORIGIN,
  AGENT_WRITE_HEADER,
  originOf,
  systemOrigin,
  agentOriginHeaders,
} from "./internal/origin";
export type { WriteOrigin } from "./internal/origin";
