import { declaredDeps, pinStatus } from "@plugins/infra/plugins/deps/deps";
import { isRelease } from "@plugins/infra/plugins/paths/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import type { PinDrift, PinnedDepRow } from "../../core";

/**
 * Every pinned dependency against main's checkout — the git store's own
 * checkout (`getMainRepoRoot`), where the gateway runs the daemons' start
 * scripts from and so whose declaration `pinnedDep` reports drift against;
 * never a worktree's, nor main's served slot. Read only: nothing installs or
 * moves.
 */
export async function checkPinDrift(): Promise<PinDrift> {
  if (isRelease()) {
    return {
      kind: "not-applicable",
      reason: "A release runs the binaries its bundle sealed",
    };
  }
  const pinned = (await declaredDeps()).filter((dep) => dep.pin !== null);
  if (pinned.length === 0) {
    return {
      kind: "not-applicable",
      reason: "No dependency of this checkout declares a pin",
    };
  }
  const mainRoot = await getMainRepoRoot();
  const rows = await Promise.all(
    pinned.map(async (dep): Promise<PinnedDepRow> => ({
      id: dep.id,
      description: dep.description,
      appliesAt: dep.pin?.appliesAt ?? "",
      status: await pinStatus(dep, { root: mainRoot }),
    })),
  );
  return { kind: "checked", mainRoot, rows };
}

/** {@link checkPinDrift}, a failure answered as `unreadable` rather than thrown at every tab. */
export async function currentPinDrift(): Promise<PinDrift> {
  try {
    return await checkPinDrift();
  } catch (err) {
    return {
      kind: "unreadable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The ids of the pinned dependencies, whose cache dirs the push watches. */
export async function pinnedDepIds(): Promise<string[]> {
  return (await declaredDeps())
    .filter((dep) => dep.pin !== null)
    .map((dep) => dep.id);
}
