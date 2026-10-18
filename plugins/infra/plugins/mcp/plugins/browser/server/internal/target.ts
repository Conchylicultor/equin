import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { resolveCheckoutDeploy } from "@plugins/infra/plugins/paths/core";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import type { HostTarget } from "../../shared/protocol";

/**
 * Resolve a conversation to the deploy ITS checkout's last build registered —
 * the same registry lookup the e2e harness makes (`resolveCheckoutDeploy`),
 * never a URL derived from a name. So an agent's route always lands on its own
 * build. An unbuilt checkout is `unbuilt`, not a refusal: its session still
 * browses absolute URLs, and the host refuses a route, the one thing with
 * nowhere to land, rather than silently driving main.
 */
export async function resolveTarget(
  conversationId: string,
): Promise<HostTarget> {
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error(`Unknown conversation "${conversationId}".`);
  const resolution = resolveCheckoutDeploy(conv.worktreePath);
  if (resolution.kind === "none") {
    return { kind: "unbuilt", checkout: conv.worktreePath };
  }
  const { namespace } = resolution.deploy;
  return { kind: "deploy", origin: namespaceUrl(namespace), namespace };
}
