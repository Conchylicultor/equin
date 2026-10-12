import {
  foldResource,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useCallback, useMemo } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  pluginTree,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/core";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import type { ConfigRegistration } from "@plugins/config_v2/web";
import { configModifiedCounts } from "@plugins/config_v2/core";
import type { ConfigV2ConflictLocations } from "@plugins/config_v2/core";
import {
  DataView,
  defineDataView,
  type FieldDef,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type { TreeViewOptions } from "@plugins/primitives/plugins/data-view/plugins/tree/web";
import { configDetailPane } from "../internal/panes";
import { pruneConfigTree } from "../internal/prune-config-tree";
import {
  flattenConfigTree,
  type ConfigNavRow,
} from "../internal/flatten-config-tree";
import { useConflictMap } from "../internal/use-conflicts";
import { ConfigRowBadge } from "./config-row-badge";

const CONFIG_NAV_VIEW = defineDataView("config_v2.settings.nav");

// No expand hooks. Expand/collapse is per-(surface, view-instance, row) device-
// local render state owned by the data-view primitive — never a domain field —
// so the nav's four authored view instances each keep their own collapse
// instead of sharing one mount-local set. Pairs with `defaultExpanded: true`,
// which reproduces the old empty-collapsed-set (everything expanded) start.
const configHierarchy: HierarchyConfig<ConfigNavRow> = {
  getParentId: (r) => r.parentId,
  getRank: (r) => r.rank,
};

export function ConfigNav() {
  const registrations = useConfigRegistrations();
  const openPane = useOpenPane();

  const treeRes = useLive(pluginTree);
  // Rows are built only for a ready tree; `readiness` (below) renders the
  // loading and failed states, so neither ever reaches the view as a value.
  const payload = foldResource(treeRes, {
    loading: () => undefined,
    error: () => undefined,
    ready: (tree) => tree,
  });

  // Modified/conflict state, read once data-level (no per-row config hooks).
  // While either map is loading (or failed) its answer is `undefined` — not
  // known — and the whole nav renders its loading or error state (`readiness`
  // below): the Modified /
  // Conflict fields decide which rows a view's filter keeps (the authored
  // "Conflicts" view is `conflict is true`), so rendering rows before both maps
  // land would show that view as confirmed-empty — "no conflicts" — while the
  // answer is still unknown.
  const modifiedRes = useLive(configModifiedCounts);
  const conflictRes = useConflictMap();
  // The nav is ready only when all three are: the plugin tree and both maps.
  // Precedence error > loading.
  const readiness = useCombinedResources({
    tree: treeRes,
    modified: modifiedRes,
    conflict: conflictRes,
  });

  // Keyed by the canonical DOT-form plugin id. `reg.pluginId` is already dot and
  // equals `PluginNode.id`, so no slash→dot bridging is needed.
  const byPluginId = useMemo(() => {
    const m = new Map<string, ConfigRegistration[]>();
    for (const reg of registrations) {
      const list = m.get(reg.pluginId);
      if (list) list.push(reg);
      else m.set(reg.pluginId, [reg]);
    }
    return m;
  }, [registrations]);

  const rows = useMemo<ConfigNavRow[]>(() => {
    if (!payload) return [];
    const matched = new Set<string>();
    const pruned = pruneConfigTree(payload.plugins, byPluginId, matched);

    // Defensive: a config registration should always map to a plugin-tree node
    // (both derive from the same plugin set). If one doesn't, surface it loudly
    // and still render it so the settings page is never silently lost.
    const orphans = registrations.filter((r) => !matched.has(r.pluginId));
    if (orphans.length > 0) {
      console.warn(
        "[config] registrations missing from plugin tree:",
        orphans.map((r) => r.pluginId),
      );
      const byOrphanId = new Map<string, ConfigRegistration[]>();
      for (const reg of orphans) {
        const list = byOrphanId.get(reg.pluginId);
        if (list) list.push(reg);
        else byOrphanId.set(reg.pluginId, [reg]);
      }
      for (const orphanRegs of byOrphanId.values()) {
        const [reg] = orphanRegs;
        if (!reg) continue;
        const node: PluginNode = {
          path: reg.pluginId,
          name: reg.pluginName,
          id: reg.pluginId,
          loadBearing: false,
          collapsed: false,
          runtimes: { web: true, server: false, central: false },
          children: [],
          facets: {},
        };
        pruned.push({ node, registrations: orphanRegs, children: [] });
      }
    }
    return flattenConfigTree(pruned);
  }, [payload, byPluginId, registrations]);

  // `undefined` = not known yet. A row with no registration (a group header)
  // has no config of its own, so it is known-unmodified.
  const modifiedCountOf = useCallback(
    (row: ConfigNavRow): number | undefined => {
      if (!row.registration) return 0;
      const storePath = row.registration.storePath;
      return foldResource(modifiedRes, {
        loading: () => undefined,
        // Not known: the nav renders the failure through `readiness`.
        error: () => undefined,
        ready: (counts) => counts[storePath] ?? 0,
      });
    },
    [modifiedRes],
  );
  // `null` = known not to conflict; `undefined` = not known yet.
  const conflictOf = useCallback(
    (row: ConfigNavRow): ConfigV2ConflictLocations | null | undefined => {
      if (!row.registration) return null;
      const storePath = row.registration.storePath;
      return foldResource(conflictRes, {
        loading: () => undefined,
        // Not known: the nav renders the failure through `readiness`.
        error: () => undefined,
        ready: (map) => map[storePath] ?? null,
      });
    },
    [conflictRes],
  );

  const selectedPath = configDetailPane.useRouteEntry()?.params.configPath;
  const selectedRowId = useMemo(() => {
    if (!selectedPath) return undefined;
    return rows.find(
      (r) =>
        r.registration &&
        encodeURIComponent(r.registration.storePath) === selectedPath,
    )?.id;
  }, [rows, selectedPath]);

  const handleActivate = useCallback(
    (row: ConfigNavRow) => {
      // Narrowing only — `expandOnActivate` routes every registration-less row
      // to a toggle, so activation never reaches one.
      if (!row.registration) return undefined;
      return openPane.to(
        configDetailPane,
        { configPath: encodeURIComponent(row.registration.storePath) },
        { mode: "push" },
      );
    },
    [openPane],
  );

  // Typed fields drive the data-view filter builder. `label` is the primary
  // (only-rendered-in-tree) field; the rest are filter-only — invisible in the
  // tree body but usable in the "Filter" pill (Modified / Conflict / Source).
  // `filterable: false` keeps them out of the full-text search accessor.
  const fields = useMemo<FieldDef<ConfigNavRow>[]>(
    () => [
      { id: "label", label: "Name", primary: true, value: (r) => r.label },
      {
        id: "modified",
        label: "Modified",
        type: "bool",
        filterable: false,
        value: (r) => {
          const count = modifiedCountOf(r);
          return count === undefined ? undefined : count > 0;
        },
      },
      {
        id: "conflict",
        label: "Conflict",
        type: "bool",
        filterable: false,
        value: (r) => {
          const conflict = conflictOf(r);
          return conflict === undefined ? undefined : conflict !== null;
        },
      },
      {
        id: "source",
        label: "Source",
        type: "enum",
        filterable: false,
        options: [
          { value: "manual", label: "Authored" },
          { value: "reorder", label: "Reorder" },
          { value: "view", label: "View" },
        ],
        value: (r) => r.registration?.descriptor.source ?? undefined,
      },
    ],
    [modifiedCountOf, conflictOf],
  );

  const treeOptions = useMemo<TreeViewOptions<ConfigNavRow>>(
    () => ({
      expandAll: true,
      defaultExpanded: true,
      // Group / multi-config header rows have no config of their own, so a body
      // click has nothing to open — it was inert. Route it to the chevron
      // instead; `rowActivation` then only ever sees a real config row.
      expandOnActivate: (r) => !r.registration,
      trailing: (r) => (
        <ConfigRowBadge
          modifiedCount={modifiedCountOf(r)}
          conflict={conflictOf(r) ?? undefined}
          source={r.registration?.descriptor.source}
        />
      ),
    }),
    [modifiedCountOf, conflictOf],
  );

  return (
    <DataView<ConfigNavRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.id}
      views={["tree"]}
      storageKey={CONFIG_NAV_VIEW}
      readiness={readiness}
      hierarchy={configHierarchy}
      selectedRowId={selectedRowId}
      rowActivation={handleActivate}
      searchAccessor={(r) => r.searchText}
      viewOptions={{ tree: treeOptions }}
    />
  );
}
