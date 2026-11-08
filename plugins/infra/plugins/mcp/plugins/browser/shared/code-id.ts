import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "node:path";

/** The folders whose source the host process runs (the rest is the backend's). */
const HOST_SOURCE_DIRS = ["bin", "shared", "core"] as const;

/**
 * Which code a host runs: a content hash of this plugin's own host-side
 * source. The host stamps it into its status; a backend whose checkout hashes
 * differently replaces the host (closing its sessions), and one that hashes the
 * same keeps every session — so a push that does not touch the agent browser
 * leaves agents' tabs alone. Node-only: never imported from `web/`.
 *
 * Imports into other plugins are not hashed; a change there that alters the
 * wire bumps `HOST_PROTOCOL` instead.
 */
export function hostCodeIdSync(pluginDir: AppPath): string {
  const hash = createHash("sha256");
  for (const dir of HOST_SOURCE_DIRS) {
    const root = joinAppPath(pluginDir, dir);
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => joinAppPath(root, name))
      .sort();
    for (const file of files) {
      hash.update(relative(pluginDir, file));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex").slice(0, 16);
}
