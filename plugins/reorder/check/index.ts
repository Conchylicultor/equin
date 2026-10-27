import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { buildRegistryGenContext } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  explainInclusion,
  resolveComposition,
  type CompositionManifest,
} from "@plugins/plugin-meta/plugins/closure/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

// Applying a committed slot layout ships wherever slots render: reorder's
// middleware is a companion of `primitives.slot-render`. Editing one is the
// Config pane's reorder-tree field (`reorder.editor`, dnd-kit). So the hard
// closure of slot-render alone — what every served bundle carries for slots —
// must not reach the layout editor. One convenience import from the apply path
// (a type or a component from the editor) would put it back into every bundle,
// with nothing failing.
//
// `primitives.sortable-list` (dnd-kit) is deliberately NOT listed: the apply
// path imports none of it, but slot-render's closure still reaches it through `config_v2 → fields.list.config` (the Config pane's
// list field renderer) — a dnd-kit route of its own, not a layout-editing one.
const APPLY_ROOT = "primitives.slot-render" as PluginId;
const EDIT_ONLY = ["reorder.editor"] as PluginId[];

const check: Check = {
  id: "reorder:apply-is-lean",
  description:
    "The hard closure of primitives.slot-render (reorder's apply path, a companion in every served bundle) does not reach the layout editor, reorder.editor.",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const { graph } = await buildRegistryGenContext(root);
    const manifest: CompositionManifest = {
      name: "reorder-apply",
      entryPoints: [APPLY_ROOT],
      selectedContributors: [],
    };
    const { bundle } = resolveComposition(graph, manifest);
    const leaked = EDIT_ONLY.filter((id) => bundle.has(id));
    if (leaked.length === 0) return { ok: true };
    const paths = leaked.map((id) => {
      const path = explainInclusion(graph, manifest, id);
      const trail = path
        ? path.steps.map((s) => `${s.from} →(${s.kind}) ${s.to}`).join("\n    ")
        : "(no path found)";
      return `${id}:\n    ${trail}`;
    });
    return {
      ok: false,
      message: `${APPLY_ROOT}'s closure reaches the layout editor: ${leaked.join(", ")}`,
      hint: `Applying a slot layout ships in every served bundle; editing one ships only with the Config pane's reorder-tree field. Move the import off the apply path (reorder, reorder/area, the node types). Inclusion paths:\n  ${paths.join("\n  ")}`,
    };
  },
};

export default check;
