import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * The listen address of a launched app, and its ONE runtime authority.
 *
 * A released bundle's listen address can be expressed in exactly two places:
 * `RELEASE.json`'s `port` (the build's default, which is what makes a bundle
 * runnable by double-click with no environment at all) and `EQUIN_LISTEN`
 * (the runtime override). Nothing else.
 *
 * `EQUIN_LISTEN` replaced the older `PORT` override rather than joining
 * it. `PORT` was a strictly weaker form of the same knob — no bind host — and
 * the bind host is the whole point: a deployment sits behind Caddy on loopback,
 * and "the gateway is not reachable off-box" must be a property of how it was
 * started, not of whether someone also remembered a firewall rule. Two knobs
 * for one value would let the weaker one win by accident.
 *
 * Unset, the gateway binds loopback only — both `127.0.0.1` and `[::1]`, via
 * the host keyword {@link LOOPBACK_BIND} that the gateway's `-listen` expands.
 * Every interface is an explicit opt-in (`:9000`), so the agent manager is
 * never reachable off-box (and never trips the macOS "accept incoming network
 * connections" prompt) unless someone asked for it.
 */

// The LISTEN variable is the single runtime listen override, `host:port`.

/**
 * The bind host keyword for "loopback only, both families": the gateway's
 * `-listen loopback:<port>` expands it into one listener on `127.0.0.1:<port>`
 * and one on `[::1]:<port>` (gateway/main.go `listenAddrs`). The default.
 */
export const LOOPBACK_BIND = "loopback";

/** A resolved listen address. `host: null` is a wildcard bind (all interfaces). */
export interface ListenAddress {
  /**
   * Bind host exactly as the gateway's `-listen` wants it: {@link LOOPBACK_BIND},
   * a literal (`127.0.0.1`, `[::1]`) passed to `net.Listen`, or null for
   * wildcard (every interface — only when explicitly asked for with `:<port>`).
   */
  host: string | null;
  port: number;
}

/**
 * Resolve where to listen: `EQUIN_LISTEN` if set, else `manifestPort` on
 * loopback ({@link LOOPBACK_BIND}). An explicit `:<port>` is the wildcard opt-in.
 *
 * A malformed override throws rather than falling back to the manifest — a
 * typo'd bind host that silently became a wildcard is exactly the failure this
 * knob exists to prevent, so it must never be absorbable.
 */
export function resolveListenAddress(manifestPort: number): ListenAddress {
  const raw = readEnv("LISTEN");
  if (raw === undefined || raw.trim() === "") {
    return {
      host: LOOPBACK_BIND,
      port: assertPort(manifestPort, `RELEASE.json "port"`),
    };
  }

  const value = raw.trim();
  // Last colon, so an IPv6 literal (`[::1]:9100`) splits at the right one. The
  // host is kept verbatim — brackets included — because it is passed straight
  // through to the gateway's `-listen`, which is a Go `net.Listen` address.
  const split = value.lastIndexOf(":");
  if (split < 0) {
    throw new Error(
      `${envName("LISTEN")}="${value}" is not a host:port address. Use "${LOOPBACK_BIND}:9100" (or leave it unset) to listen on loopback only, "127.0.0.1:9100" for one address, or ":9100" to listen on all interfaces.`,
    );
  }
  const host = value.slice(0, split);
  return {
    host: host === "" ? null : host,
    port: assertPort(
      Number(value.slice(split + 1)),
      `${envName("LISTEN")}="${value}"`,
    ),
  };
}

/** The `-listen` flag value for a resolved address. */
export function listenFlag(addr: ListenAddress): string {
  return `${addr.host ?? ""}:${addr.port}`;
}

function assertPort(port: number, source: string): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid listen port ${String(port)} from ${source}`);
  }
  return port;
}
