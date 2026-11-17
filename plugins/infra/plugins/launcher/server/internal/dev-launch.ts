import type { GatewayLaunchOptions } from "./boot";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { resolveListenAddress } from "./listen";

/** `./equin start`'s `--log-level` default. */
export const DEV_GATEWAY_LOG_LEVEL = "info";

/**
 * The launch options of the machine's dev gateway — what `./equin start`
 * installs, and what the health report's gateway drift row compares the
 * installed one against. One derivation, so the two cannot disagree on what
 * "current" means.
 *
 * Everything but the binary, which is MAIN's `gateway-binary` build (whichever
 * checkout asks): `repoRoot` is main's checkout, `logLevel` `start`'s flag,
 * `port` this account's gateway port and `legacyPort` the one it moved off
 * (both `launcher/gateway-port` — read by the caller, which alone knows whether
 * it may choose one).
 */
export function devGatewayLaunchOptions(opts: {
  repoRoot: string;
  logLevel: string;
  port: number;
  legacyPort: number | null;
}): Omit<GatewayLaunchOptions, "executable"> {
  return {
    cwd: opts.repoRoot,
    port: opts.port,
    bindHost: devBindHost(opts.port),
    logLevel: opts.logLevel,
    // The dev gateway is what deploys main: it runs main's convergence in
    // main's checkout on every advance of refs/heads/main.
    mainCheckout: opts.repoRoot,
    legacyPort: opts.legacyPort,
  };
}

/**
 * Where the dev gateway binds: loopback by default (127.0.0.1 and [::1]), or the
 * host `EQUIN_LISTEN` names — the one listen override a release honours
 * too. Every interface is the explicit opt-in `EQUIN_LISTEN=:<port>`, so the
 * agent manager is off-box only when someone asked for it. Only the HOST may
 * change: the port is the account's (`./equin start --port` moves it), which
 * the CLI, the menu-bar helper and every bookmark read.
 *
 * `EQUIN_LISTEN` is a forwarded runtime name, so a backend reads the value
 * the gateway's starter had.
 */
function devBindHost(port: number): string | null {
  const addr = resolveListenAddress(port);
  if (addr.port !== port) {
    throw new Error(
      `${envName("LISTEN")} names port ${addr.port}, but this account's gateway listens on ${port} (move it with \`./equin start --port <n>\`). Set only the host, e.g. ${envName("LISTEN")}=127.0.0.1:${port}.`,
    );
  }
  return addr.host;
}
