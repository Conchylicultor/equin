import { useMemo } from "react";
import type {
  FieldDef,
  FieldExtensionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { PageRow } from "@plugins/page/plugins/editor/core";
import { agentPages, type AgentPageRow } from "../../shared/resources";

const NO_IDS: ReadonlySet<string> = new Set<string>();

// Stable (module-level), so the `select` re-runs only when the set changes.
function toIdSet(rows: readonly AgentPageRow[]): ReadonlySet<string> {
  return new Set(rows.map((r) => r.blockId));
}

/**
 * Field extension contributed into the page-tree's `PageTree.Fields` factory: a
 * render-callback component that reads this plugin's own live `agentPages`
 * set into a `Set<string>` and yields one `origin` enum `FieldDef<PageRow>`
 * closed over the set. That makes `origin` a filter dimension of the one
 * `pages-sidebar` DataView — the **Private** and **Scratch** sections are two
 * view instances of it, `origin is user` / `origin is agent`, each authored
 * with `filterScope: "roots"` in that surface's config, with no bespoke
 * sidebar.
 */
export function OriginField({ render }: FieldExtensionProps<PageRow>) {
  // An empty set while pending is the correct read: every page then projects
  // "user", so Private holds the whole tree until the resource settles — never
  // a flash of pages under Scratch and never an unresolvable rule. A failed
  // read projects the same empty set: the split is an enrichment, and the tree
  // itself stays correct without it.
  const result = useLive(agentPages, { select: toIdSet });
  const agentIds = foldResource(result, {
    loading: () => NO_IDS,
    error: () => NO_IDS,
    ready: (ids) => ids,
  });
  const fields = useMemo<FieldDef<PageRow>[]>(
    () => [
      {
        id: "origin",
        label: "Origin",
        type: "enum",
        options: [
          // Labelled after the sidebar sections the values select.
          { value: "user", label: "Private" },
          { value: "agent", label: "Scratch" },
        ],
        // Unmarked rows project "user", never null — so every page lands in
        // exactly one of the two sections, and a group-by on it has no "None"
        // bucket.
        value: (b) => (agentIds.has(b.id) ? "agent" : "user"),
        // Search-accessor only: keeping `origin` out of the full-text search
        // accessor (it is a grouping dimension, not searchable text). It stays
        // in the Filter pill, which is gated on the field type resolving
        // operators.
        filterable: false,
        // `groupable` is left at its enum DEFAULT (true), so a view can still
        // group by it. The sidebar no longer does: its sections are a
        // root-scoped FILTER per view (`filterScope: "roots"`), which keeps
        // each root's whole subtree in one section exactly as a group-by on
        // the roots did — and lets the two halves be separate sections, each
        // with its own header, collapse and hide-when-empty.
      },
    ],
    [agentIds],
  );
  return <>{render(fields)}</>;
}
