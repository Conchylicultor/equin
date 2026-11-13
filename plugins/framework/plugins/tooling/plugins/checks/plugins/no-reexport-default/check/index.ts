import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/structure-records/core";
import { defineFoldCheck } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { defaultExportFold } from "./no-reexport-default.scan";

const RUNTIMES = ["web", "server", "machine", "central"] as const;

/** Every barrel position a plugin tree path can hold: `<plugin>/<runtime>/index.ts`. */
const BARREL_RE =
  /^plugins\/[^/]+(?:\/plugins\/[^/]+)*\/(?:web|server|machine|central)\/index\.ts$/;

// A fold check: each barrel's default-export shape is its record
// (./no-reexport-default.scan.ts), kept along the directory tree, so a pass
// after an edit reads only the edited barrels. The fold covers every barrel
// position; the verdict keeps the barrels of the plugin tree's own nodes.
const check = defineFoldCheck({
  id: "no-reexport-default",
  description:
    "Every plugin barrel (web|server|machine|central)/index.ts must use inline `export default { ... } satisfies *PluginDefinition` — no re-exports, no missing defaults",
  context: () => null,
  files: (repo) => repo.under("plugins").filter((p) => BARREL_RE.test(p)),
  async facts(ctx) {
    const repo = await ctx.repo();
    const tree = await buildStructureTreeOnce(
      joinAppPath(repo.root, "plugins"),
      repo,
    );
    const barrels = new Set<string>();
    for (const node of tree.byDir.values())
      for (const runtime of RUNTIMES)
        barrels.add(`plugins/${node.path}/${runtime}/index.ts`);
    return barrels;
  },
  fold: defaultExportFold,
  verdict(found, { facts: barrels }) {
    const inTree = found.filter((p) => barrels.has(p.barrel));
    const problems = [
      ...inTree
        .filter((p) => p.kind === "missing")
        .map((p) => `  missing default export: ${p.barrel}`),
      ...inTree
        .filter((p) => p.kind === "reexported")
        .map((p) => `  re-exported default: ${p.barrel}`),
    ];

    if (problems.length === 0) return { ok: true };

    return {
      ok: false,
      message: `${problems.length} barrel(s) violate inline default export rule:\n${problems.join("\n")}`,
      hint: "Add `export default { description } satisfies ServerPluginDefinition` (or PluginDefinition / CentralPluginDefinition) inline in the barrel. (`id` is derived from the plugin path — never authored; there is no `name` field.)",
    };
  },
});

export default check;
