import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { pathExistsSync } from "@plugins/plugin-meta/plugins/parse-utils/plugins/source-files/core";
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
export function readManifest(dir: AppPath): DeclaredExemption[] {
  const file = joinAppPath(dir, "exempt", "index.ts");
  if (!pathExistsSync(file)) return [];
  delete require.cache[require.resolve(file)];
  const mod = require(file) as { default?: Exemptions };
  return (mod.default ?? []).map((e) => ({
    rule: e.rule,
    paths: [...e.paths],
    kind: e.kind,
  }));
}
