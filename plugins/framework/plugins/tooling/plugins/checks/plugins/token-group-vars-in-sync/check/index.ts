import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import {
  buildBarrelFreeTree,
  collectTokenGroupVars,
  renderTokenGroupVarsManifest,
  tokenGroupVarsManifestPath,
  formatGenerated,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { asPath } from "@plugins/framework/plugins/plugin-id/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * The static reading of the token groups (cross-refs `tokenGroups`: each
 * `defineTokenGroup` call's id and schema keys, read from source) must equal
 * the imported descriptors, and each group must be registered by the plugin
 * that declares it. That reading is what makes styling with a token a hard
 * closure edge to the token's plugin; if it drifted, a bundle would silently
 * lose the group its members paint with.
 */
async function staticOwnershipProblems(root: string): Promise<string[]> {
  const [imported, tree] = await Promise.all([
    collectTokenGroupVars(root),
    buildBarrelFreeTree(root),
  ]);
  const declared = new Map<string, { plugin: string; vars: string[] }>();
  const registrars = new Map<string, string[]>();
  for (const node of tree.byDir.values()) {
    for (const g of getFacet(node, crossRefsFacetDef)?.tokenGroups ?? [])
      declared.set(g.id, { plugin: asPath(node.id), vars: g.vars });
    for (const c of getFacet(node, contributionsFacetDef)?.static ?? []) {
      if (c.slot !== "ThemeEngine.TokenGroup" || !c.props.id) continue;
      const id = JSON.parse(c.props.id) as string;
      registrars.set(id, [...(registrars.get(id) ?? []), asPath(node.id)]);
    }
  }
  const problems: string[] = [];
  for (const [id, vars] of Object.entries(imported)) {
    const d = declared.get(id);
    if (!d) {
      problems.push(
        `token group "${id}" is registered but no plugin's core/ declares it with a statically readable defineTokenGroup("${id}", { … })`,
      );
      continue;
    }
    if (d.vars.join() !== vars.join())
      problems.push(
        `token group "${id}" (${d.plugin}): its source reads as ${d.vars.join(", ")} but the descriptor supplies ${vars.join(", ")}`,
      );
    const by = registrars.get(id) ?? [];
    if (by.length !== 1 || by[0] !== d.plugin)
      problems.push(
        `token group "${id}" is declared in ${d.plugin} but registered by ${by.join(", ") || "no plugin's static contributions"} — the declaring plugin's web/ must register it, so the token edge lands on the plugin that paints the var`,
      );
  }
  for (const [id, d] of declared)
    if (!(id in imported))
      problems.push(
        `token group "${id}" is declared in ${d.plugin} but no web barrel registers it`,
      );
  return problems;
}

const check: Check = {
  id: "token-group-vars-in-sync",
  description:
    "plugins/framework/plugins/tooling/plugins/checks/core/token-group-vars.generated.ts matches the current token-group descriptors, and their static reading (which derives token-use closure edges) matches too",
  async run() {
    const root = await getWorktreeRoot();
    const file = tokenGroupVarsManifestPath(root);
    const rel = relative(root, file);
    if (!existsSync(file)) {
      return {
        ok: false,
        message: `${rel} is missing`,
        hint: "Run `./singularity build` to generate it.",
      };
    }
    const expected = await formatGenerated({
      file,
      content: await renderTokenGroupVarsManifest(root),
    });
    if (readFileSync(file, "utf8") !== expected) {
      return {
        ok: false,
        message: `${rel} is out of sync with the token-group descriptors`,
        hint: "Run `./singularity build` and commit the regenerated file.",
      };
    }
    const problems = await staticOwnershipProblems(root);
    if (problems.length > 0) {
      return {
        ok: false,
        message: problems.join("\n"),
        hint: "Declare each group with a literal id and an object-literal schema (inline or a same-file const) in its plugin's core/, and register it from that plugin's web/.",
      };
    }
    return { ok: true };
  },
};

export default check;
