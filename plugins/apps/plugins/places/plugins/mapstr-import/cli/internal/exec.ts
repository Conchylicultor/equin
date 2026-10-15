import { runExec } from "@plugins/framework/plugins/server-core/cli";
import { checkoutNamespace } from "@plugins/infra/plugins/paths/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

/**
 * Boots this checkout's backend in `exec` mode — its DB, config, the Maps key
 * and the jobs queue, no serving — runs `body` with the namespace, and exits.
 * `body` must load the server-side code itself (a dynamic import): only after
 * the boot has declared the runtime namespace may it be evaluated.
 */
export async function inThisCheckout(
  body: (namespace: string) => Promise<void>,
): Promise<never> {
  const namespace = await checkoutNamespace(await getWorktreeRoot());
  return runExec(namespace, () => body(namespace));
}
