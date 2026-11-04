import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { join, relative } from "path";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { declareSlotsFromBarrels } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { loadFacets } from "@plugins/plugin-meta/plugins/facets/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  appPathParent,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = { id: string; description: string; run(): Promise<CheckResult> };

// The three browser render surfaces every facet must cover. Each entry is a
// stable web-slot id (the registry key) owned by a consumer plugin. A
// contribution names its facet via `facetId` (diff/contributions, explicit
// field) or `id` (detail sections carry the facet id as their section id). Only
// the explicit `facetId` surfaces (diff/contributions) get orphan detection —
// `plugin-view.section` is a generic slot that may host non-facet sections.
const RENDER_SURFACES = [
  {
    surface: "diff",
    slotId: "review.plugin-changes.diff-renderer",
    facetKey: "facetId" as const,
    explicit: true,
  },
  {
    surface: "detail",
    slotId: "plugin-meta.plugin-view.section",
    facetKey: "id" as const,
    explicit: false,
  },
  {
    surface: "contributions",
    slotId: "plugin-meta.contributions-table.facet-table",
    facetKey: "facetId" as const,
    explicit: true,
  },
];

const check: Check = {
  id: "facets:render-complete",
  description:
    "Every facet from loadFacets() has a render contributor in each web render slot (diff, detail, contributions) with a matching facet id",
  async run() {
    const root = await getWorktreeRoot();
    const pluginsRoot = joinAppPath(root, "plugins");
    const facetIds = (await loadFacets()).map((f) => f.def.id).sort();
    const facetIdSet = new Set(facetIds);

    const tree = await buildStructureTreeOnce(pluginsRoot);
    registerBarrelStubs(appPathParent(pluginsRoot));

    // This check imports web barrels ITSELF (the tree above is structure-only),
    // so it must also declare their slots: a contribution names its slot by
    // object, and that slot's id comes from whichever plugin declares it.
    // Without a pass there is nothing to compare a contribution's slot against.
    //
    // `"source"`, not `"registry"`: this check asks a question about SOURCE —
    // "does every facet have a renderer contributed" — and a disabled plugin's
    // renderer is still a real declaration in the tree. One of the surfaces
    // below, `review.plugin-changes.diff-renderer`, is owned by the disabled
    // `review/plugins/plugin-changes`, so under registry scope it would not be
    // declared at all and every facet would read as missing its diff renderer.
    const naming = await declareSlotsFromBarrels(root, "source");

    // Resolved ONCE, here, and compared by object identity in the loop below.
    // A slot id is derived from its declaring plugin, so moving that plugin
    // renames every slot it owns — and an id spelled inside the loop would then
    // simply match nothing, which reads as "no facet contributes a renderer"
    // rather than as the stale literal it is. Resolved up front, the same
    // mistake is one named failure naming the id and the scope.
    //
    // `findSlot`, never `slotNamed`: the check runner awaits every check under
    // `Promise.all` and rethrows, so a throw here would kill every other check's
    // reporting. A miss is this check's own `{ ok: false }`.
    const surfaces: {
      slot: SlotHandle;
      def: (typeof RENDER_SURFACES)[number];
    }[] = [];
    for (const def of RENDER_SURFACES) {
      const slot = naming.findSlot(def.slotId);
      if (!slot) {
        return {
          ok: false,
          message:
            `No slot is declared under the id "${def.slotId}" (the ${def.surface} render surface) ` +
            `in the "source" declaration pass — every plugin this checkout declares, disabled ones ` +
            `included. Either the id here is stale (a slot's id is \`<pluginId>.<slots key>\`, so ` +
            `moving or renaming the declaring plugin renames it) or the plugin that declared it no ` +
            `longer does.`,
        };
      }
      surfaces.push({ slot, def });
    }

    const covered = new Map(
      RENDER_SURFACES.map((s) => [s.slotId, new Set<string>()]),
    );
    const orphans: { surface: string; facetId: string; dir: string }[] = [];

    for (const node of tree.byDir.values()) {
      const webIndex = join(node.dir, "web", "index.ts");
      if (!existsSync(webIndex)) continue;
      let mod: Record<string, unknown>;
      try {
        mod = await importBarrel(webIndex);
      } catch (err) {
        return {
          ok: false,
          message: `Failed to import web barrel ${relative(root, webIndex)}: ${String(err)}`,
        };
      }
      const def = mod.default as
        | {
            contributions?: Array<
              Record<string, unknown> & { _slot?: SlotHandle }
            >;
          }
        | undefined;
      const contributions = def?.contributions;
      if (!contributions) continue;
      for (const c of contributions) {
        const surface = surfaces.find((s) => s.slot === c._slot)?.def;
        if (!surface) continue;
        const fid = c[surface.facetKey];
        if (typeof fid !== "string") continue;
        covered.get(surface.slotId)!.add(fid);
        if (surface.explicit && !facetIdSet.has(fid)) {
          orphans.push({
            surface: surface.surface,
            facetId: fid,
            dir: relative(root, node.dir),
          });
        }
      }
    }

    const missing: string[] = [];
    for (const fid of facetIds) {
      for (const s of RENDER_SURFACES) {
        if (!covered.get(s.slotId)!.has(fid)) {
          missing.push(
            `    facet "${fid}" → missing ${s.surface} renderer (no contribution to ${s.slotId})`,
          );
        }
      }
    }

    if (missing.length === 0 && orphans.length === 0) return { ok: true };

    const parts: string[] = [];
    if (missing.length) {
      parts.push(
        `${missing.length} missing facet render surface(s):\n${missing.join("\n")}`,
      );
    }
    if (orphans.length) {
      parts.push(
        `${orphans.length} render contribution(s) target an unknown facet:\n${orphans
          .map(
            (o) =>
              `    ${o.surface} renderer in ${o.dir} → facetId "${o.facetId}" (no such facet)`,
          )
          .join("\n")}`,
      );
    }
    return {
      ok: false,
      message: parts.join("\n\n"),
      hint: "Add the missing render-{diff,detail,contributions}/web sub-plugin under the facet's folder (see plugins/plugin-meta/plugins/facets/CLAUDE.md), or fix the facetId/section id.",
    };
  },
};

export default check;
