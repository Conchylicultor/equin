import type { ReactNode } from "react";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type { ResourceUnavailable } from "@plugins/primitives/plugins/live-state/core";
import type {
  DataViewDensity,
  DataViewGroupHeaders,
  DataViewId,
  DataViewProps,
  DataViewReserve,
  DataViewToolbarSpec,
  ToolbarParts,
} from "../../core";
import type { DataViewContribution } from "../slots";
import type { ReadyViewModel } from "./use-data-view-model";

/**
 * Per-surface chrome the shell builds once and hands to the body. The body
 * renders the toolbar (its query input is a per-instance concern), but the
 * switcher, the surface `title`/`actions`, and the toolbar-height measurement
 * ref all belong to the surface — they must survive an active-instance switch.
 */
export interface DataViewShellChrome {
  /** The view switcher in both forms — `EditableViewSwitcher` (`strip`) and
   *  `CollapsedViewSwitcher` (`chip`) — built by the shell (model inputs only)
   *  and placed by the toolbar as opaque nodes. Both `null` when pinned. */
  switcher: ToolbarParts["switcher"];
  /** Number of view instances — the compact toolbar hides a single-view switcher. */
  switcherCount: number;
  title?: ReactNode;
  actions?: ReactNode;
  /**
   * The surface's declared density (`DataViewProps.density`). It travels on the
   * chrome rather than reaching the body twice because both hosts —
   * `DataView` and `DataViewSwitcher` — build their chrome through the one
   * `DataViewShellFrame`, so there is a single place the value can be set and a
   * single place the body reads it from. Absent ⇒ `"comfortable"`.
   */
  density?: DataViewDensity;
  /** The surface's group-header treatment (`DataViewProps.groupHeaders`), a
   *  surface property carried like `density`. Absent ⇒ `"standard"`. */
  groupHeaders?: DataViewGroupHeaders;
  /** The surface's toolbar (`DataViewProps.toolbar`): a band arrangement, or a
   *  hosted frame; absent ⇒ the default bar. A surface property, carried like
   *  `density`. */
  toolbar?: DataViewToolbarSpec;
  /** The search placeholder (`DataViewProps.searchPlaceholder`), a surface
   *  property carried like `toolbar`. Absent ⇒ `"Search…"`. */
  searchPlaceholder?: string;
  /** The shell's toolbar-measurement ref. The body attaches it to the toolbar's
   *  `<Sticky>` so the shell can publish the measured height as
   *  `--dv-header-offset` on the shell root. */
  stickyRef: (node: HTMLElement | null) => void;
  /** The surface's side panel (`DataViewProps.aside`), a surface property
   *  carried like `toolbar`. The body places it, inside the controls context. */
  aside?: ReactNode;
  /** The surface's backdrop view type (`DataViewProps.backdrop`), a surface
   *  property carried like `aside`. Validated by the shell. */
  backdrop?: string;
  /** The room the surface's own chrome covers (`DataViewProps.reserve`). */
  reserve?: DataViewReserve;
}

/** `Omit` over each member of a union — a plain `Omit` of a union is not a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Everything a data source supplies: the full `DataViewProps` surface minus the
 * per-surface keys the shell owns (`storageKey` / `title` / `actions` /
 * `defaultView` / `views` / `density` / `groupHeaders` / `toolbar` /
 * `searchPlaceholder` / `aside` / `backdrop` / `reserve`).
 *
 * `density` is on that list for the same reason `title` is: it describes the
 * SURFACE, not the data bundle, and the body reads it off `chrome`. Omitting it
 * here means a source contributor cannot even spell a density the host would
 * then silently ignore.
 *
 * DISTRIBUTIVE over the data-origin union: a plain `Omit` would merge its arms
 * into one object type, and `{ source, rows }` would type-check again on the
 * `DataViewSwitcher` path.
 *
 * Its `readiness` is never `unavailable`: that arm replaces the whole surface,
 * which the `DataView` shell renders before any body mounts — a body (and a
 * `DataViewSwitcher` source, whose body sits under the shell's switcher)
 * only ever sees the three states of a read that can arrive.
 */
export type DataViewSourceBundle<TRow> = WithoutUnavailable<
  DataViewSurfaceBundle<TRow>
>;

/** `readiness` minus its `unavailable` arm, per member of the origin union. */
type WithoutUnavailable<T> = T extends { readiness?: infer R }
  ? Omit<T, "readiness"> & { readiness?: Exclude<R, ResourceUnavailable> }
  : T;

type DataViewSurfaceBundle<TRow> = DistributiveOmit<
  DataViewProps<TRow>,
  | "storageKey"
  | "title"
  | "actions"
  | "defaultView"
  | "views"
  | "density"
  | "groupHeaders"
  | "toolbar"
  | "searchPlaceholder"
  | "aside"
  | "backdrop"
  | "reserve"
>;

/** Props of the per-active-instance body (`DataViewBody`) — an intersection,
 *  since an interface cannot extend the bundle's union. */
export type DataViewBodyProps<TRow> = DataViewSourceBundle<TRow> & {
  storageKey: DataViewId;
  viewModel: ReadyViewModel;
  activeInstance: ResolvedViewInstance<DataViewContribution>;
  chrome: DataViewShellChrome;
};
