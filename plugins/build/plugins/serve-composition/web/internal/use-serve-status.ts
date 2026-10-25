import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  asNamespace,
  namespaceHost,
} from "@plugins/infra/plugins/namespace/core";
import { serveStatus } from "../../shared/serve-status";

/**
 * What a surface may claim about a composition's live serve. A discriminated
 * result, so "we have not been told yet" and "nothing is served" can never be
 * rendered as the same thing — the whole point of the read: `serve` is an
 * intent, and a link built from an intent points at a namespace that 502s.
 */
export type ServeStatus =
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      /**
       * Where this composition is — or would be — served from the backend that
       * answered. Resolved SERVER-side (`namespaceFor(id, its own checkout)`):
       * a composition served from a worktree lives at
       * `<id>.<checkout>.localhost:9000`, and the browser cannot work that out
       * from the namespace it is talking to.
       */
      namespace: string;
      /** `<namespace>.localhost:9000` — the display form of the same fact. */
      host: string;
      /** The full origin, as the server named it. */
      url: string;
      live:
        | { served: false }
        | { served: true; commit: string | null; builtAt: string };
      /**
       * Whether the automatic serve modes are acted on by the backend that
       * answered — a fact about THAT BACKEND, not about this composition. They
       * run on main only, so a worktree's panel must say so rather than offer
       * "On every push" and never act on it.
       */
      autoTriggersHere: boolean;
    };

/**
 * Where is `composition` served from this backend's checkout, and is anything
 * actually there right now?
 *
 * The truth is the `composition.json` marker on the shared filesystem, read
 * through the `build.serve-status` live value. Freshness is push-based, not
 * polled: the backend watches the marker for as long as this is mounted, so a
 * serve build landing it (or a reclaim removing the namespace) is pushed.
 *
 * `composition` is the manifest item's **id**, never its display name. A host
 * without the computer behind it has no marker to read, and says so as an
 * `error` — the surfaces render it as "could not read the serve state", never
 * as "not served".
 */
export function useServeStatus(composition: string): ServeStatus {
  const result = useLive(serveStatus, { composition });
  return useMemo<ServeStatus>(() => {
    if (result.status === "loading") return { kind: "pending" };
    if (result.status === "unavailable")
      return { kind: "error", message: result.message };
    if (result.status === "error")
      return { kind: "error", message: result.error.message };
    const { namespace, url, liveness, autoTriggersHere } = result.data;
    return {
      kind: "ready",
      namespace,
      // The one cast, at the wire boundary, on a value the SERVER resolved —
      // not a namespace this hook composed. `namespaceHost` is what turns it
      // into the string a chip shows; the origin comes back as `url`.
      host: namespaceHost(asNamespace(namespace)),
      url,
      autoTriggersHere,
      live: liveness.served
        ? {
            served: true,
            commit: liveness.commit,
            builtAt: liveness.builtAt,
          }
        : { served: false },
    };
  }, [result]);
}
