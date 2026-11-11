import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";
import {
  checkoutNamespace,
  worktreeArtifacts,
} from "@plugins/infra/plugins/paths/core";
import { realGates } from "./gates";
import type { Cooldown } from "../../core/internal/updater";
import {
  runUpgrade,
  type UpgradeReceipt,
  type UpgradeSelection,
} from "./runner";

/**
 * `./equin deps upgrade [<id>]` (and its alias `toolchain upgrade`) in
 * this checkout: refuses the main checkout, writes the receipt in the
 * worktree data dir (`deps-upgrade-<id>.json` for one updater,
 * `deps-upgrade.json` for a batch of several), runs the real gates. Returns the
 * receipt when something landed or nothing could (`current`, `waiting`); throws on `regressed`,
 * `aborted` (files already put back) and `holds-to-review` (nothing touched),
 * so every caller exits non-zero on them.
 */
export async function upgradeThisWorktree(
  selection: readonly UpgradeSelection[],
  opts: { cooldown: Cooldown },
): Promise<UpgradeReceipt> {
  const root = await getWorktreeRoot();
  if (root === (await getMainRepoRoot())) {
    throw new Error(
      `Refusing to run the ${selection.map((s) => s.updater.id).join(", ")} upgrade in the main checkout. Main's backend runs on its locks; ` +
        "a new release is proven in a worktree and reaches main through `./equin push`.",
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
    cooldown: opts.cooldown,
  });
  console.log(`\nverdict: ${receipt.verdict}`);
  if (receipt.verdict === "regressed")
    throw new Error(
      `${what}: regressed — nothing landed, the locks were put back (the receipt names each culprit).`,
    );
  if (receipt.verdict === "holds-to-review")
    throw new Error(
      `${what}: ${receipt.holdsToReview.length} hold(s) past their review date — nothing was planned. ` +
        "Lift each (delete it) or renew it (a new `reviewBy` and a reason saying what was checked), then run again.",
    );
  if (receipt.verdict === "aborted")
    throw new Error(
      `${what}: aborted before a verdict — the locks were put back.\n${receipt.error ?? ""}`,
    );
  return receipt;
}
