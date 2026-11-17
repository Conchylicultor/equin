import { gatewayOriginFor } from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";

/**
 * The OAuth redirect URI of a provider: the callback on the bare loopback
 * origin of the gateway on `port` (not a namespace subdomain — the gateway
 * forwards `/api/auth/callback/*` to central from any host). The user registers
 * it with the provider, so it names this account's port: central passes the
 * port of the gateway it runs under (`servedGatewayPort`), a setup UI its
 * page's own (`pagePort`).
 */
export function oauthRedirectUri(providerId: string, port: number): string {
  return `${gatewayOriginFor(port)}/api/auth/callback/${providerId}`;
}
