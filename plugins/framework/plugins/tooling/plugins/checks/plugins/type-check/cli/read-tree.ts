import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { TypeCheckTree } from "../core";
import { readCheckTree } from "../shared/repo-view";

/**
 * The working tree as `spawnTypeCheckWorker` checks it: the git tree plus the
 * overlay of gitignored files the tsconfig makes roots of
 * (`../shared/repo-view.ts`).
 */
export async function readTypeCheckTree(
  root: AppPath,
  tsconfigPath: string,
): Promise<TypeCheckTree> {
  return (await readCheckTree(root, tsconfigPath)).tree;
}
