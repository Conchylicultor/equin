import { useMemo } from "react";
import {
  admits,
  type EndpointAccess,
} from "@plugins/framework/plugins/principal/core";
import { pagePrincipal } from "@plugins/framework/plugins/principal/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import type { MachineAvailability, MachineFeature } from "../../core";
import { unavailableMessage } from "../../core";

/**
 * Whether this subtree may send a write — for a side-write nobody clicked (a
 * toast recorded in the bell) or a control gated before its click. Two
 * reasons it may not, each fixed for the subtree's life:
 *
 * - the write needs the computer and the subtree's transport has none
 *   (`needsMachine`, as `useMachineAvailability`);
 * - the subtree talks to the PAGE's server, which took this page for a
 *   deployed site's visitor at boot (`framework/principal`'s
 *   `pagePrincipal`), and the endpoint's `access` does not admit a visitor —
 *   its gate would answer 403. An in-browser server's only caller is the page
 *   itself, the owner of what it holds.
 *
 * A page whose boot recorded no principal (`unknown`) is not refused here:
 * the server's gate stays the authority.
 */
export function useWriteAvailability(endpoint: {
  readonly route: string;
  readonly access: EndpointAccess;
  readonly needsMachine?: MachineFeature;
}): MachineAvailability {
  const { machine, server } = useTransport();
  const { route, access, needsMachine } = endpoint;
  return useMemo((): MachineAvailability => {
    if (needsMachine !== undefined && !machine) {
      return { available: false, message: unavailableMessage(needsMachine) };
    }
    const principal = server === "page" ? pagePrincipal() : "owner";
    if (principal === "visitor" && !admits(access, { kind: "visitor" })) {
      return {
        available: false,
        message: `${route} is its owner's only — this page is a visitor of the site it is served from.`,
      };
    }
    return { available: true };
  }, [machine, server, route, access, needsMachine]);
}
