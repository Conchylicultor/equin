import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import {
  checkoutNamespace,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { realGates } from "./gates";
import {
  runUpgrade,
  type UpgradeReceipt,
  type UpgradeSelection,
} from "./runner";

/**
 * `./singularity deps upgrade [<id>]` (and its alias `toolchain upgrade`) in
 * this checkout: refuses the main checkout, writes the receipt in the
 * worktree data dir (`deps-upgrade-<id>.json` for one updater,
 * `deps-upgrade.json` for a batch of several), runs the real gates. Returns the
 * receipt when something landed or nothing had to; throws on `regressed` and
 * `aborted` (files already put back), so every caller exits non-zero on them.
 */
export async function upgradeThisWorktree(
  selection: readonly UpgradeSelection[],
): Promise<UpgradeReceipt> {
  const root = await getWorktreeRoot();
  if (root === (await getMainRepoRoot())) {
    throw new Error(
      `Refusing to run the ${selection.map((s) => s.updater.id).join(", ")} upgrade in the main checkout. Main's backend runs on its locks; ` +
        "a new release is proven in a worktree and reaches main through `./singularity push`.",
    );
  }
  const slug = await checkoutNamespace(root);
  const only = selection.length === 1 ? selection[0] : undefined;
  const what = selection.map((s) => s.updater.id).join(", ");
  const receipt = await runUpgrade({
    selection,
    root,
    receiptPath:
      only !== undefined
        ? worktreeArtifacts.depsUpgrade(slug, only.updater.id)
        : worktreeArtifacts.depsUpgradeBatch(slug),
    gates: realGates(root, slug),
    log: (line) => console.log(line),
  });
  console.log(`\nverdict: ${receipt.verdict}`);
  if (receipt.verdict === "regressed")
    throw new Error(
      `${what}: regressed — nothing landed, the locks were put back (the receipt names each culprit).`,
    );
  if (receipt.verdict === "aborted")
    throw new Error(
      `${what}: aborted before a verdict — the locks were put back.\n${receipt.error ?? ""}`,
    );
  return receipt;
}
