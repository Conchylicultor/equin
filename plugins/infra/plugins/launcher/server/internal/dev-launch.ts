import type { GatewayLaunchOptions } from "./boot";
import { LISTEN_ENV, resolveListenAddress } from "./listen";

/**
 * The port the machine's dev gateway always listens on: every backend reaches
 * central through `localhost:9000`.
 */
export const DEV_GATEWAY_PORT = 9000;

/** `./equin start`'s `--log-level` default. */
export const DEV_GATEWAY_LOG_LEVEL = "info";

/**
 * The launch options of the machine's dev gateway — what `./equin start`
 * installs, and what the health report's gateway drift row compares the
 * installed one against. One derivation, so the two cannot disagree on what
 * "current" means.
 *
 * Everything but the binary, which is MAIN's `gateway-binary` build (whichever
 * checkout asks): `repoRoot` is main's checkout, `logLevel` `start`'s flag.
 */
export function devGatewayLaunchOptions(opts: {
  repoRoot: string;
  logLevel: string;
}): Omit<GatewayLaunchOptions, "gateway"> {
  return {
    cwd: opts.repoRoot,
    port: DEV_GATEWAY_PORT,
    bindHost: devBindHost(),
    logLevel: opts.logLevel,
  };
}

/**
 * Where the dev gateway binds: loopback by default (127.0.0.1 and [::1]), or the
 * host `SINGULARITY_LISTEN` names — the one listen override a release honours
 * too. Every interface is the explicit opt-in `SINGULARITY_LISTEN=:9000`, so the
 * agent manager is off-box only when someone asked for it. Only the HOST may
 * change: every backend reaches central at `localhost:9000`.
 *
 * `SINGULARITY_LISTEN` is a forwarded runtime name, so a backend reads the value
 * the gateway's starter had.
 */
function devBindHost(): string | null {
  const addr = resolveListenAddress(DEV_GATEWAY_PORT);
  if (addr.port !== DEV_GATEWAY_PORT) {
    throw new Error(
      `${LISTEN_ENV} names port ${addr.port}, but the dev gateway must listen on ${DEV_GATEWAY_PORT} (backends reach central at localhost:${DEV_GATEWAY_PORT}). Set only the host, e.g. ${LISTEN_ENV}=127.0.0.1:${DEV_GATEWAY_PORT}.`,
    );
  }
  return addr.host;
}
