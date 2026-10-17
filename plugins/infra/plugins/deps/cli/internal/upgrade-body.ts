import { declaredUpdaters } from "@plugins/infra/plugins/deps/plugins/updates/server";
import { upgradeThisWorktree } from "@plugins/infra/plugins/deps/plugins/updates/cli";

/**
 * The body of `deps upgrade`, in its own module because it imports the
 * updates plugin's server barrel statically: that barrel evaluates config
 * needing the runtime namespace, so this module may only load inside
 * `runExec` (see `./upgrade.ts`).
 *
 * No `id`: every declared updater, as one batch. An `id`: that updater alone,
 * optionally restricted to `only`.
 */
export async function upgrade(
  id: string | undefined,
  only: readonly string[] | undefined,
): Promise<void> {
  const updaters = declaredUpdaters();
  if (id === undefined) {
    if (only !== undefined)
      throw new Error(
        "`--only` names one updater's inputs: name the updater too.",
      );
    if (updaters.length === 0) throw new Error("No updater is declared.");
    await upgradeThisWorktree(updaters.map((updater) => ({ updater })));
    return;
  }
  const updater = updaters.find((u) => u.id === id);
  if (updater === undefined) {
    throw new Error(
      `No updater ${JSON.stringify(id)}. Updaters: ${updaters.map((u) => u.id).join(", ") || "none"}.`,
    );
  }
  await upgradeThisWorktree([{ updater, only }]);
}
