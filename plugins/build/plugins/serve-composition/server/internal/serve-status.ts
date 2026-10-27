import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { REPO_ROOT, checkoutRef } from "@plugins/infra/plugins/paths/server";
import { loadCompositionMarker } from "@plugins/infra/plugins/worktree/server";
import {
  namespaceFor,
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import type { ServeStatusResponse } from "../../shared/endpoints";

/**
 * The namespace a serve build of `composition` started HERE would publish.
 *
 * Resolved rather than received. `REPO_ROOT` is the checkout this backend runs
 * out of — main's for the main app, the building worktree's for a composition
 * served from one — so `namespaceFor(composition, checkoutRef)` is the
 * namespace a marker for it would live under. The browser cannot compose it: it
 * knows the namespace it is talking to, and a namespace does not decompose back
 * into its (composition, checkout) pair.
 */
export async function serveNamespaceOf(
  composition: string,
): Promise<Namespace> {
  return namespaceFor(composition, await checkoutRef(REPO_ROOT));
}

/**
 * WHERE is this composition served from here, and is anything actually there?
 * The one reading behind both the `build.serve-status` live value and the
 * `GET /api/build/serve/status` endpoint.
 *
 * The marker is the only honest answer to the second question: a serve build
 * writes `composition.json` into the namespace dir before it composes anything,
 * so its presence is what distinguishes a live URL from a config flag nothing
 * has acted on yet. `loadCompositionMarker` reads the shared
 * `~/.equin/worktrees/` tree, so a backend can answer for a namespace it
 * does not itself serve.
 *
 * The third answer is about this BACKEND rather than the composition:
 * `autoTriggersHere` says whether the automatic serve modes are acted on here at
 * all. They run on main only — the durable `git.refAdvanced` event is emitted
 * only from main, and a per-worktree schedule would have every live agent
 * worktree rebuilding the same compositions — so a worktree's panel would
 * otherwise offer "On every push" and silently never act on it.
 *
 * There is no `canServe` any more. It answered "is this backend main?", because
 * the serve stage ran inside main's build; a serve is now an ordinary build of
 * this checkout, startable anywhere. Whether a composition may be served AT ALL
 * (main's may not — its namespace is the checkout's own app) is
 * `isServableCompositionId`, a pure function of the id that every surface can
 * call directly.
 *
 * `composition` must already be a valid namespace label (`namespaceFor` throws
 * on one that is not); each caller validates it its own way.
 */
export async function readServeStatus(
  composition: string,
): Promise<ServeStatusResponse> {
  const ns = await serveNamespaceOf(composition);
  const marker = await loadCompositionMarker(ns);
  return {
    namespace: ns,
    url: namespaceUrl(ns),
    liveness:
      marker === null
        ? ({ served: false } as const)
        : ({
            served: true,
            // Markers written before the field carry no commit. Reported as
            // unknown rather than back-filled from a guess.
            commit: marker.commit ?? null,
            builtAt: marker.builtAt,
          } as const),
    autoTriggersHere: isMain(),
  };
}
