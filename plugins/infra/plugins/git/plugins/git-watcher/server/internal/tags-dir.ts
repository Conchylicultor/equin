import { mkdir } from "node:fs/promises";
import { realpath } from "@plugins/packages/plugins/timed-fs/core";

/**
 * `<common>/refs/tags` as the filesystem reports it (what the dir-watch hub
 * takes), created first when missing: git makes it at init, but a repo may
 * have lost it, and an empty one is what git itself would leave.
 */
export async function ensureTagsDir(commonDir: string): Promise<string> {
  const dir = `${commonDir}/refs/tags`;
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}
