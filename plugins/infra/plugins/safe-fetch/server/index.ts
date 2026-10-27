import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  SsrfError,
  TooManyRedirectsError,
  isUnreachableError,
  parsePublicUrl,
  assertResolvesPublic,
  buildPinnedDial,
  isPrivateIp,
  safeFetch,
} from "./internal/ssrf";
export type { SafeFetchInit, PinnedDial } from "./internal/ssrf";

export default {
  description:
    "SSRF-guarded fetch primitive: parsePublicUrl + DNS-resolution checks (isPrivateIp/assertResolvesPublic) and safeFetch, which dials the validated IP directly (closing the DNS-rebinding TOCTOU) while preserving Host/SNI/cert via Bun fetch tls.serverName, following redirects with per-hop revalidation so a target can never reach loopback/private/link-local/metadata addresses.",
} satisfies ServerPluginDefinition;
