import { LEGACY_GATEWAY_PORT } from "@plugins/infra/plugins/namespace/core";
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * The port of the gateway that started this process — what a backend, central
 * or a deploy run dials to reach its own gateway (`gatewayOriginFor`).
 *
 * The gateway sets this variable (key `GATEWAY_PORT`) from its own `-listen` for every child
 * (gateway/env.go), so the answer always names the gateway the process runs
 * under: the account's port on a desktop, RELEASE.json's on a deployed box.
 * Unset only under a gateway built before that variable existed — and every
 * such gateway listened on {@link LEGACY_GATEWAY_PORT}, so that is the answer,
 * not a guess.
 */
export function servedGatewayPort(): number {
  const raw = readEnv("GATEWAY_PORT");
  if (raw === undefined) return LEGACY_GATEWAY_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(
      `[gateway-port] ${envName("GATEWAY_PORT")} is ${JSON.stringify(raw)}, not a port. The gateway sets it from its own -listen.`,
    );
  }
  return port;
}

/**
 * The port a page talks to its gateway on: its own. A page is always served by
 * the gateway it talks to, so its location is the authority — an empty port
 * is the scheme's default, never a constant stood in for it.
 */
export function pagePort(loc: { port: string; protocol: string }): number {
  if (loc.port !== "") return Number(loc.port);
  return loc.protocol === "https:" ? 443 : 80;
}
