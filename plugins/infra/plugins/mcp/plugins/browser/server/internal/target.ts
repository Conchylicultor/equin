import { appCheckoutOf } from "@plugins/infra/plugins/worktree/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { lookupCheckoutDeploy } from "@plugins/infra/plugins/paths/core";
import {
  MAIN_WORKTREE_NAME,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import type { HostTarget } from "../../shared/protocol";

/**
 * Resolve a conversation to the deploy ITS checkout's last build registered —
 * read from the specs a build of it could have written (`lookupCheckoutDeploy`
 * — a few reads, never a scan of the registry), never a URL derived from a
 * name. So an agent's route always lands on its own
 * build. An unbuilt checkout is `unbuilt`, not a refusal: its session still
 * browses absolute URLs, and the host refuses a route, the one thing with
 * nowhere to land, rather than silently driving main.
 */
export async function resolveTarget(
  conversationId: string | null,
): Promise<HostTarget> {
  // A session equin did not launch has no checkout of its own: its routes land
  // on main (read-only to agents, as for every agent session).
  if (conversationId === null) {
    return {
      kind: "deploy",
      origin: namespaceUrl(MAIN_WORKTREE_NAME),
      namespace: MAIN_WORKTREE_NAME,
    };
  }
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error(`Unknown conversation "${conversationId}".`);
  // The app's own checkout this conversation runs in, re-derived from the
  // app's roots (a path read from a record is never trusted as an app path);
  // a workspace that is no checkout of the app's has no deploy.
  const checkout = await appCheckoutOf(conv.worktreePath);
  const resolution =
    checkout === null
      ? ({ kind: "none" } as const)
      : await lookupCheckoutDeploy(checkout);
  if (resolution.kind === "none") {
    return { kind: "unbuilt", checkout: conv.worktreePath };
  }
  const { namespace } = resolution.deploy;
  return { kind: "deploy", origin: namespaceUrl(namespace), namespace };
}
