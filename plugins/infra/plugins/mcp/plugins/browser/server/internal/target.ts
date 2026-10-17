import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { resolveCheckoutDeploy } from "@plugins/infra/plugins/paths/core";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";

/** The deploy a conversation's browser session drives: its own checkout's build. */
export interface BrowserTarget {
  /** `http://<namespace>.localhost:9000`, no trailing slash. */
  origin: string;
  namespace: string;
}

/**
 * Resolve a conversation to the deploy ITS checkout's last build registered —
 * the same registry lookup the e2e harness makes (`resolveCheckoutDeploy`),
 * never a URL derived from a name. So an agent's route always lands on its own
 * build, and an unbuilt worktree is a loud refusal rather than a silent drive
 * of main.
 */
export async function resolveTarget(
  conversationId: string,
): Promise<BrowserTarget> {
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error(`Unknown conversation "${conversationId}".`);
  const resolution = resolveCheckoutDeploy(conv.worktreePath);
  if (resolution.kind === "none") {
    throw new Error(
      `No deploy is registered for this conversation's checkout (${conv.worktreePath}). ` +
        `Run \`./singularity build\` there first, or pass an absolute http:// URL.`,
    );
  }
  const { namespace } = resolution.deploy;
  return { origin: namespaceUrl(namespace), namespace };
}
