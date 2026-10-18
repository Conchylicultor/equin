import { buildRegistryGenContext } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { crossRefsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";
import { asPath } from "@plugins/framework/plugins/plugin-id/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

/**
 * Every key a keyed companion serves, and every view type a DataView uses,
 * resolves.
 *
 * A keyed companion ships only while its key is used (`UsageRule`), so a key
 * nothing can use — `match: "dat"` — is a contribution that never ships, and a
 * view type nothing renders — an authored `"view": { "type": "tabel" }` row —
 * is a DataView view that silently has no renderer in any bundle. Both are
 * spelling mistakes the engine would otherwise absorb:
 *
 * - a `field-type` companion's key must be a type some plugin defines
 *   (`defineFieldType("<id>")`);
 * - a `view-type` key a plugin references (an authored config row, a
 *   `views={[…]}` whitelist) must be one some renderer serves.
 */
export const keysDefined: Check = {
  id: "keys-defined",
  description:
    "Every field type a keyed companion serves is defined, and every view type a DataView authors or whitelists has a renderer",
  async run() {
    const root = await getWorktreeRoot();
    const { tree, graph } = await buildRegistryGenContext(root);

    const definedFieldTypes = new Set<string>();
    for (const node of tree.byDir.values())
      for (const def of getFacet(node, crossRefsFacetDef)?.keyDefs ?? [])
        definedFieldTypes.add(def.key);
    const servedViewTypes = new Set(
      graph.rules.filter((r) => r.space === "view-type").map((r) => r.key),
    );

    const problems: string[] = [];
    for (const rule of graph.rules)
      if (rule.space === "field-type" && !definedFieldTypes.has(rule.key))
        problems.push(
          `${asPath(rule.then)}: serves field type "${rule.key}", which no plugin defines`,
        );
    for (const node of tree.byDir.values())
      for (const ref of getFacet(node, crossRefsFacetDef)?.keyRefs ?? [])
        if (ref.space === "view-type" && !servedViewTypes.has(ref.key))
          problems.push(
            `${asPath(node.id)}: uses view type "${ref.key}", which no renderer serves`,
          );

    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "Keys nothing resolves — a companion that never ships, or a DataView view no bundle can render:\n  " +
        problems.join("\n  "),
      hint: 'Fix the spelling. A field type is `defineFieldType("<id>")` in its plugin\'s core/; a view type is the `type` of a `DataViewSlots.View({ type, companion: true })` contribution.',
    };
  },
};
