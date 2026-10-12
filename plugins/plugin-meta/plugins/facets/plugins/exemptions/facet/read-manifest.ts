import { existsSync } from "fs";
import { join } from "path";
import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import type { DeclaredExemption } from "../core";

/**
 * The plugin's manifest, imported (not text-scanned): a manifest is plain data
 * whose only imports are types, so it loads synchronously and its entries are
 * exactly what the loader (`loadExemptions`) sees — no second parser to drift.
 * A manifest that fails to load throws; `exempt:manifests-valid` is the
 * authority on validity, this facet only reports what loaded.
 *
 * Read FRESH on every call: the faceted tree is rebuilt in the long-lived
 * server process whenever a file under `plugins/` changes (the notified
 * `plugin-view.facets-tree` value), and `require` would otherwise hand back the
 * module it cached at the first build — so an edited manifest would stay stale
 * until the server restarts.
 */
export function readManifest(dir: string): DeclaredExemption[] {
  const file = join(dir, "exempt", "index.ts");
  if (!existsSync(file)) return [];
  delete require.cache[require.resolve(file)];
  const mod = require(file) as { default?: Exemptions };
  return (mod.default ?? []).map((e) => ({
    rule: e.rule,
    paths: [...e.paths],
    kind: e.kind,
  }));
}
