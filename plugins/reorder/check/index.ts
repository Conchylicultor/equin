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
// middlewares are companions of `primitives.slot-render`. Editing one is
// opt-in. So the hard closure of slot-render alone — what every served bundle
// carries for slots — must not reach the layout editor. One convenience import
// from the apply path (a type from the editor, a component from edit-mode)
// would put it back into every bundle, with nothing failing.
//
// `primitives.sortable-list` (dnd-kit) is deliberately NOT listed: the apply
// path imports only its dnd-free `deferred-item`, but slot-render's closure
// still reaches it through `config_v2 → fields.list.config` (the Config pane's
// list field renderer) — a dnd-kit route of its own, not a layout-editing one.
const APPLY_ROOT = "primitives.slot-render" as PluginId;
const EDIT_ONLY = ["reorder.edit-mode", "reorder.editor"] as PluginId[];

const check: Check = {
  id: "reorder:apply-is-lean",
  description:
    "The hard closure of primitives.slot-render (reorder's apply path, a companion in every served bundle) reaches neither layout-editing plugin: reorder.edit-mode, reorder.editor.",
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
      message: `${APPLY_ROOT}'s closure reaches layout-editing plugins: ${leaked.join(", ")}`,
      hint: `Applying a slot layout ships in every served bundle; editing one ships only with reorder.edit-mode. Move the import off the apply path (reorder, reorder/area, the node types), or reach the editor through ReorderSlots.AreaEditor. Inclusion paths:\n  ${paths.join("\n  ")}`,
    };
  },
};

export default check;
