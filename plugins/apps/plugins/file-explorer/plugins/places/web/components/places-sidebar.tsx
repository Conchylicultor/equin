import { useMemo, type CSSProperties, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
  type RowDropConfig,
  type RowDropContext,
} from "@plugins/primitives/plugins/data-view/web";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import {
  hasHostPaths,
  readHostPaths,
} from "@plugins/infra/plugins/host-fs/core";
import type { SectionsToolbar } from "@plugins/primitives/plugins/data-view/core";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  useExplorerLocation,
  useHomeDir,
  useExplorerFolderTarget,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { absolutePath } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import {
  FileExplorer,
  type PlacesSource,
  type PlacesState,
} from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { pinRowKey, useFavorites } from "../internal/favorites";
import type { PlaceRow } from "../internal/place-row";
import { PlacesSlots } from "../slots";

const PLACES_VIEW = defineDataView("file-explorer.places");

/** The Favorites section's view id (config-authored, `file-explorer.places`). */
const FAVORITES = "favorites";

/**
 * Every authored section (Favorites, Worktrees, Locations) at once, each under
 * its quiet group heading (sentence case, the `group` role in the theme's
 * group tone).
 */
const SECTIONS: SectionsToolbar = {
  kind: "sections",
  forms: { header: "group" },
};

const GROUP_OPTIONS = [
  { value: "favorites", label: "Favorites" },
  { value: "locations", label: "Locations" },
];

const fields: FieldDef<PlaceRow>[] = [
  { id: "label", label: "Name", primary: true, value: (r) => r.label },
  {
    id: "group",
    label: "Group",
    type: "enum",
    options: GROUP_OPTIONS,
    value: (r) => r.group,
  },
];

/**
 * The list's options for the place showing now (`activeId`). A place reads in
 * the sidebar's muted text at the regular weight, its icon in the same tone,
 * and comes up to full text on hover; the active place is full text at medium
 * weight with its icon in the accent. A failed source's row says why on hover
 * (its muted tone says it is not a place to go).
 */
function listOptions(activeId: string | undefined) {
  const tone = (r: PlaceRow) =>
    r.id === activeId
      ? "text-sidebar-accent-foreground"
      : // The row's own hover group (`Row`'s action anchor), never a bare
        // `group` an outer surface may also carry.
        "text-sidebar-foreground group-hover/row-actions:text-sidebar-accent-foreground";
  return {
    list: {
      leading: (r: PlaceRow) => (
        <span
          title={r.message ?? undefined}
          className={cn(r.id === activeId ? "text-sidebar-primary" : tone(r))}
          style={NAV_ICON_GAP}
        >
          <Icon icon={r.icon} className="size-4" />
        </span>
      ),
      // The label role at its full size (the list is compact, which would
      // step it down to the caption rung).
      labelClassName: (r: PlaceRow) =>
        cn(
          "text-label",
          r.id === activeId ? "font-medium" : "font-normal",
          tone(r),
        ),
    },
  };
}

/**
 * The places' icon-to-label gap is the sidebar nav rows' (sidebar-metrics
 * `sidebarIconGap`): the row's own `xs` gap plus the rest as the icon's margin.
 */
const NAV_ICON_GAP = {
  marginInlineEnd: "calc(var(--sidebar-icon-gap) - var(--space-xs))",
} as CSSProperties;

/**
 * The active place wears the sidebar's hover wash, not the app's selection
 * fill (that is the tree's accent-soft blue).
 */
const SIDEBAR_SELECTION = {
  "--selected": "var(--sidebar-accent)",
} as CSSProperties;

/**
 * The Places sidebar: the places of every `FileExplorer.Places` source as a
 * DataView list in sections — Favorites, Worktrees, Locations (config-authored
 * filters on `group`). The place whose folder the explorer is showing is the active row.
 * The list grows to fill the sidebar, so the storage meter after it sits at
 * the bottom.
 */
export function PlacesSidebar(): ReactNode {
  const sources = FileExplorer.Places.useContributions();
  return (
    <ResolvePlaces sources={sources} index={0} resolved={[]}>
      {(rows, pending) => <PlacesList rows={rows} pending={pending} />}
    </ResolvePlaces>
  );
}

/**
 * Resolve every source's `usePlaces` hook — one component per source, chained,
 * so each hook has its own component and the call order never changes.
 */
function ResolvePlaces({
  sources,
  index,
  resolved,
  children,
}: {
  sources: readonly PlacesSource[];
  index: number;
  resolved: readonly { source: PlacesSource; state: PlacesState }[];
  children: (rows: PlaceRow[], pending: boolean) => ReactNode;
}): ReactNode {
  const source = sources[index];
  if (source === undefined) {
    const { rows, pending } = placeRows(resolved);
    return children(rows, pending);
  }
  return (
    <ResolveSource key={source.id} source={source}>
      {(state) => (
        <ResolvePlaces
          sources={sources}
          index={index + 1}
          resolved={[...resolved, { source, state }]}
        >
          {children}
        </ResolvePlaces>
      )}
    </ResolveSource>
  );
}

function ResolveSource({
  source,
  children,
}: {
  source: PlacesSource;
  children: (state: PlacesState) => ReactNode;
}): ReactNode {
  const { usePlaces } = source;
  return children(usePlaces());
}

/**
 * Every resolved source's places as rows, in source order; a failed source is
 * one muted row saying why. `pending` while any source has not answered.
 */
function placeRows(
  resolved: readonly { source: PlacesSource; state: PlacesState }[],
): { rows: PlaceRow[]; pending: boolean } {
  const rows: PlaceRow[] = [];
  let pending = false;
  for (const { source, state } of resolved) {
    switch (state.kind) {
      case "pending":
        pending = true;
        break;
      case "failed":
        rows.push({
          id: source.id,
          source: source.id,
          placeId: null,
          group: source.group,
          icon: state.icon,
          label: state.label,
          path: null,
          open: null,
          message: state.message,
        });
        break;
      case "ready":
        for (const place of state.places) {
          rows.push({
            id: `${source.id}:${place.id}`,
            source: source.id,
            placeId: place.id,
            group: source.group,
            icon: place.icon,
            label: place.label,
            path: place.path,
            open: place.open ?? null,
            message: null,
          });
        }
        break;
    }
  }
  return { rows, pending };
}

function PlacesList({
  rows,
  pending,
}: {
  rows: PlaceRow[];
  pending: boolean;
}): ReactNode {
  const location = useExplorerLocation();
  const home = useHomeDir();
  const folderTarget = useExplorerFolderTarget();
  const readiness: ResourceReadiness =
    pending || home.kind === "pending"
      ? { status: "loading" }
      : { status: "ready" };
  const activeId = useMemo(() => {
    if (home.kind !== "ready") return undefined;
    const abs = (p: string) => absolutePath(p, home.home);
    const here = abs(location.dir);
    const opened = location.open === null ? null : abs(location.open);
    const inHere = rows.filter((r) => r.path !== null && abs(r.path) === here);
    // The file showing, when it is a place; else the folder.
    return (
      inHere.find((r) => r.open !== null && abs(r.open) === opened) ??
      inHere.find((r) => r.open === null)
    )?.id;
  }, [rows, location.dir, location.open, home]);

  // Host paths dropped on Favorites go in the gap the line shows — between
  // any two favorites, built-in or pinned, or after the last for the
  // section's empty space: the drop places their rows in the view's own row
  // order FIRST, then pins them (a pin already there just moves). Under a
  // sort there is no gap to keep, so they are pinned at the end. The drop's
  // data is read before anything is awaited.
  const { lookUp, pin } = useFavorites();
  const rowDrop = useMemo<RowDropConfig<PlaceRow>>(() => {
    const pinDrop = (dt: DataTransfer, ctx: RowDropContext) => {
      const read = readHostPaths(dt);
      if (read.kind === "absent") return;
      if (read.kind === "malformed") {
        throw new Error(
          `file-explorer places: malformed host-paths drop: ${read.error}`,
        );
      }
      const place = async () => {
        const pins = await lookUp(read.paths);
        if (pins.length === 0) return;
        if (ctx.order) await ctx.order.insert(pins.map(pinRowKey));
        pin(pins);
      };
      // A failed lookup or order write is already shown by the endpoint
      // error toast.
      void place().catch((err: unknown) => {
        if (err instanceof EndpointError) return;
        throw err;
      });
    };
    return {
      placement: "between",
      accepts: (r, types, edge) =>
        r.group === "favorites" && edge !== "into" && hasHostPaths(types),
      onDrop: (_r, dt, _edge, ctx) => pinDrop(dt, ctx),
      background: {
        accepts: (types, at) => at.viewId === FAVORITES && hasHostPaths(types),
        onDrop: (dt, _at, ctx) => pinDrop(dt, ctx),
      },
      dropEffect: "link",
    };
  }, [lookUp, pin]);

  return (
    // The block padding sits on an inner box, never on the `Scroll`: a sticky
    // section header pins at its scroller's PADDING edge, so padding there
    // leaves a see-through strip above the pinned head.
    <Scroll fill>
      <div className="pb-xs" style={SIDEBAR_SELECTION}>
        <DataView<PlaceRow>
          rows={rows}
          readiness={readiness}
          fields={fields}
          rowKey={(r) => r.id}
          views={["list"]}
          storageKey={PLACES_VIEW}
          toolbar={SECTIONS}
          density="compact"
          selectedRowId={activeId}
          rowActivation={(r) =>
            r.path === null
              ? undefined
              : folderTarget(r.path, r.open ?? undefined)
          }
          itemActions={PlacesSlots.RowActions}
          rowDrop={rowDrop}
          rowTone={(r) => (r.path === null ? "muted" : "default")}
          viewOptions={listOptions(activeId)}
        />
      </div>
    </Scroll>
  );
}
