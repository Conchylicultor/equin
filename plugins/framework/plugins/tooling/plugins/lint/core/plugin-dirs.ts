import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Walks all directories in the `plugins/<X>/plugins/<Y>/...` nesting pattern,
 * regardless of whether they have web/server/machine/central barrels.
 */
function walkPluginTree(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
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
      if (dir === root) walk(join(dir, e.name), depth + 1);
      else if (e.name === "plugins") {
        for (const c of readdirSync(join(dir, e.name), { withFileTypes: true })) {
          if (c.isDirectory()) walk(join(dir, e.name, c.name), depth + 1);
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
export function findPluginDirs(root: string): string[] {
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
