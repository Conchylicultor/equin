import { existsSync } from "fs";
import { join } from "path";
import {
  createFacet,
  getFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { asPath } from "@plugins/framework/plugins/plugin-id/core";
import {
  readIfExists,
  walkFiles,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  type ExemptedBy,
  type ExemptionsData,
  exemptionsFacetDef,
} from "../core";
import { readManifest } from "./read-manifest";

// ── Helpers ────────────────────────────────────────────────────────────

/** The ESLint namespace of this plugin's `lint/index.ts` contribution. */
function lintNamespace(dir: string): string | undefined {
  const src = readIfExists(join(dir, "lint", "index.ts"));
  return src?.match(/\bname:\s*"([^"]+)"/)?.[1];
}

/** Every check id declared under this plugin's `check/` folder. */
function checkIds(dir: string): string[] {
  const checkDir = join(dir, "check");
  if (!existsSync(checkDir)) return [];
  const files: string[] = [];
  walkFiles(checkDir, files);
  const ids = new Set<string>();
  for (const f of files) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readIfExists(f);
    if (!src) continue;
    for (const m of src.matchAll(/\bid:\s*"([^"]+)"/g)) ids.add(m[1]!);
  }
  return [...ids];
}

// ── Facet ──────────────────────────────────────────────────────────────

export default createFacet<ExemptionsData>({
  def: exemptionsFacetDef,

  extract(ctx) {
    return {
      declared: readManifest(ctx.dir),
      exemptedBy: [],
      owns: {
        lintNamespace: lintNamespace(ctx.dir),
        checkIds: checkIds(ctx.dir),
      },
    };
  },

  relate(ctx: unknown) {
    const { tree } = ctx as { tree: PluginTree };

    // Rule id → owning plugin node. A lint rule `<ns>/<rule>` is owned by the
    // plugin whose lint barrel is named `<ns>`; a check id `<id>[:<sub>]` by
    // the plugin whose `check/` declares `<id>`.
    const lintOwners = new Map<string, ExemptionsData>();
    const checkOwners = new Map<string, ExemptionsData>();
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, exemptionsFacetDef);
      if (!data?.owns) continue;
      if (data.owns.lintNamespace !== undefined) {
        lintOwners.set(data.owns.lintNamespace, data);
      }
      for (const id of data.owns.checkIds) checkOwners.set(id, data);
    }

    for (const node of tree.byDir.values()) {
      const data = getFacet(node, exemptionsFacetDef);
      if (!data) continue;
      const counts = new Map<ExemptionsData, ExemptedBy>();
      for (const e of data.declared) {
        const owner = e.rule.includes("/")
          ? lintOwners.get(e.rule.split("/")[0]!)
          : checkOwners.get(e.rule.split(":")[0]!);
        if (!owner) continue;
        const c = counts.get(owner) ?? { plugin: node.id, debt: 0 };
        if (e.kind === "debt") c.debt += e.paths.length;
        counts.set(owner, c);
      }
      for (const [owner, c] of counts) owner.exemptedBy.push(c);
    }

    for (const node of tree.byDir.values()) {
      const data = getFacet(node, exemptionsFacetDef);
      if (!data) continue;
      data.owns = undefined;
      data.exemptedBy.sort((a, b) => a.plugin.localeCompare(b.plugin));
    }
  },

  renderDoc(data) {
    const facts: DocFact[] = [];
    if (data.declared.length > 0) {
      facts.push({
        folder: "exemptions",
        key: "Exempts itself from",
        values: data.declared.map(
          (e) =>
            `\`${e.rule}\` — ${e.paths.map((p) => `\`${p}\``).join(", ")} (${e.kind})`,
        ),
      });
    }
    if (data.exemptedBy.length > 0) {
      facts.push({
        folder: "exemptions",
        key: "Exempted by",
        values: data.exemptedBy.map(
          (x) => `\`${asPath(x.plugin)}\` (${x.debt} debt)`,
        ),
      });
    }
    return facts;
  },
});
