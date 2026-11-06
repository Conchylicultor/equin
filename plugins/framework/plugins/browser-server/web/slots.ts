import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { LiveValue } from "@plugins/network/plugins/live/core";

/**
 * A page input (`pageInput`, core): a value of the PAGE's own server that a
 * page rendering a browser host may hand it — read by the page's chrome
 * outside the host's scope, never by the host's code. Declared by the plugin
 * that owns the value, for a value the real app already sends that page
 * (the Maps browser key). The host keeps it in memory only.
 */
export interface HostInputSupply {
  /** The live value the page reads (on its own transport) and hands over, by its key. */
  value: LiveValue<unknown>;
}

export const HostInputs = {
  Supply: defineSlot<HostInputSupply>({ docLabel: (p) => p.value.key }),
};

/**
 * Third-party hosts a plugin's code loads from in the page (a map's script
 * and tiles, an instrument's samples): the one exception to a browser host's
 * "no request leaves the browser" — never the page's own server. Literal
 * hosts, read statically by the browser-host codegen into each host's
 * `externalHosts`, which the demo's no-leak e2e holds every off-origin
 * request to.
 */
export interface ExternalHostsDeclaration {
  /** Exact host names (`maps.googleapis.com`), no scheme, port or path. */
  hosts: readonly string[];
  /** Why the plugin reaches them. */
  reason: string;
}

export const ExternalHosts = {
  Declare: defineSlot<ExternalHostsDeclaration>({
    docLabel: (p) => p.hosts.join(", "),
  }),
};
