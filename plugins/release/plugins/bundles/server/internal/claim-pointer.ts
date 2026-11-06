import { rm, symlink } from "node:fs/promises";
import { latestPointerPath } from "./pointer";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Point `latest-<platform>` at `runId`.
 *
 * The ONLY writer of the pointer. It is called after a run has produced its
 * shippable artifact — never from the `--dev` staging path — so the invariant
 * "a `latest-<platform>` pointer names a PACKED run" holds by construction
 * rather than by every caller remembering it. A `--dev` run claiming the pointer
 * is what used to let `ship` resolve a run that was never packed.
 *
 * Relative target (`runId`, not the absolute dir) so the whole
 * `<comp>-<target>/` tree stays relocatable.
 */
export async function claimLatestPointer(
  compDir: AppPath,
  runId: string,
  platform: string,
): Promise<AppPath> {
  const pointer = latestPointerPath(compDir, platform);
  await rm(pointer, { force: true });
  await symlink(runId, pointer);
  return pointer;
}
