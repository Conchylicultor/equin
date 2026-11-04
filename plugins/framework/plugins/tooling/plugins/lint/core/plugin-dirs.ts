import {
  existsSync,
  readdirSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { join } from "path";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Walks all directories in the `plugins/<X>/plugins/<Y>/...` nesting pattern,
 * regardless of whether they have web/server/machine/central barrels.
 */
function walkPluginTree(root: AppPath): AppPath[] {
  const out: AppPath[] = [];
  function walk(dir: AppPath, depth: number) {
    if (depth > 10) return;
    if (dir !== root) out.push(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code == null) throw err;
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (dir === root) walk(joinAppPath(dir, e.name), depth + 1);
      else if (e.name === "plugins") {
        for (const c of readdirSync(joinAppPath(dir, e.name), {
          withFileTypes: true,
        })) {
          if (c.isDirectory())
            walk(joinAppPath(dir, e.name, c.name), depth + 1);
        }
      }
    }
  }
  walk(root, 0);
  return out;
}

/**
 * Plugin directories that have web/, server/, machine/ or central/ barrels.
 * Used by eslint.config.ts for lint rule discovery.
 */
export function findPluginDirs(root: AppPath): AppPath[] {
  return walkPluginTree(root).filter(
    (dir) =>
      existsSync(join(dir, "web", "index.ts")) ||
      existsSync(join(dir, "server", "index.ts")) ||
      existsSync(join(dir, "machine", "index.ts")) ||
      existsSync(join(dir, "central", "index.ts")) ||
      existsSync(join(dir, "check", "index.ts")) ||
      existsSync(join(dir, "lint", "index.ts")) ||
      existsSync(join(dir, "facet", "index.ts")),
  );
}
