import { type ReactNode, useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { ViewSourceEntry } from "@plugins/primitives/plugins/data-view/plugins/view-core/core";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type {
  DataViewDensity,
  DataViewGroupHeaders,
  DataViewId,
  DataViewActiveChrome,
} from "../../core";
import { DataViewSlots, type DataViewContribution } from "../slots";
import {
  useDataViewModel,
  type ReadyViewModel,
} from "../internal/use-data-view-model";
import type {
  DataViewSourceBundle,
  DataViewShellChrome,
} from "../internal/body-types";
import type {
  DataViewSources,
  DataViewSourceProps,
} from "../internal/define-data-view-sources";
import { DataViewShellFrame } from "./data-view";
import { DataViewBody } from "./data-view-body";

/** The surface chrome (`title` / `actions` / `toolbar`) is the part of
 *  `DataViewProps`' union that shows ONE active instance — a hosted toolbar
 *  excludes `title` / `actions`, and the `sections` chrome is a type error
 *  here: a merged surface mounts one source's data at a time, so it cannot
 *  stack every instance. */
export type MergedDataViewProps<THostProps> =
  MergedDataViewBaseProps<THostProps> & DataViewActiveChrome;

interface MergedDataViewBaseProps<THostProps> {
  storageKey: DataViewId;
  /** The per-consumer source slot minted by `defineDataViewSources`. */
  sources: DataViewSources<THostProps>;
  /** The host surface's own props, threaded verbatim to every source. */
  hostProps: THostProps;
  defaultView?: string;
  /** The surface's density, forwarded to the shell exactly like `title` /
   *  `actions`. It is a property of the surface, so it applies whichever source
   *  the active view-instance binds to. */
  density?: DataViewDensity;
  /** The group-header treatment, forwarded like `density` — a property of the
   *  surface, whichever source the active instance binds to. */
  groupHeaders?: DataViewGroupHeaders;
  /** The search placeholder, forwarded like `toolbar`. */
  searchPlaceholder?: string;
  /** The surface's side panel (`DataViewProps.aside`), forwarded like
   *  `toolbar` — a property of the surface, whichever source is active. */
  aside?: ReactNode;
}

/**
 * Multi-source DataView host: ONE surface (one `storageKey` → one config file →
 * one `EditableViewSwitcher`) whose view-instances each bind to a contributed
 * **source** via the config row's `source` key. The view model resolves every
 * row up front from the contributions' STATIC metadata (`views`); only the ACTIVE instance's source component mounts — its
 * data hooks run, it calls `render(bundle)`, and the bundle feeds the shared
 * `DataViewBody`. Switching sources remounts the body (`key={source.id}`), so
 * per-source subscriptions restart cleanly.
 */
export function MergedDataView<THostProps>(
  props: MergedDataViewProps<THostProps>,
): ReactNode {
  const {
    storageKey,
    sources,
    hostProps,
    title,
    actions,
    defaultView,
    density,
    groupHeaders,
    toolbar,
    searchPlaceholder,
    aside,
  } = props;
  const contributions = DataViewSlots.View.useContributions();
  const rawSourceContribs = sources.useContributions();
  // `useContributions` returns registration order; honor the contributions'
  // declared `order` (the add menu's section order and entry precedence), the
  // same explicit sort the tabbed-view host applied.
  const sourceContribs = useMemo(
    () =>
      [...rawSourceContribs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [rawSourceContribs],
  );

  // One `ViewSourceEntry` per contributed source, from static metadata only —
  // no `viewOptions` (code-only options can't exist before the source mounts;
  // the body re-merges the bundle's `viewOptions` under the instance options).
  const entries = useMemo<ViewSourceEntry<DataViewContribution>[]>(
    () =>
      sourceContribs.map((c) => ({
        id: c.id,
        title: c.title,
        icon: c.icon,
        contributions,
        views: c.views,
      })),
    [sourceContribs, contributions],
  );

  const viewModel = useDataViewModel(storageKey, entries, defaultView);

  return (
    <DataViewShellFrame
      storageKey={storageKey}
      viewModel={viewModel}
      title={title}
      actions={actions}
      density={density}
      groupHeaders={groupHeaders}
      toolbar={toolbar}
      searchPlaceholder={searchPlaceholder}
      aside={aside}
    >
      {(activeInstance, chrome, readyModel) => {
        // Always found: a row whose `source` matches no contribution never
        // resolves into an instance (`buildInstanceFromRow` fail-softs), so an
        // active instance's source is a live contribution by construction.
        const activeSource = sourceContribs.find(
          (c) => c.id === activeInstance.instance.source,
        );
        if (!activeSource) {
          throw new Error(
            `MergedDataView(${storageKey}): active instance ` +
              `"${activeInstance.instance.id}" resolved with unknown source ` +
              `"${activeInstance.instance.source ?? ""}"`,
          );
        }
        return renderIsolated(
          sources,
          activeSource as unknown as Contribution,
          {
            hostProps,
            // The host consumes the bundle at `unknown` row space — the same
            // documented cast boundary as field extensions (the contributor keeps
            // full `TRow` typing; the shared body machinery is row-type-erased).
            render: (bundle) => (
              <MergedSourceBody
                storageKey={storageKey}
                viewModel={readyModel}
                activeInstance={activeInstance}
                chrome={chrome}
                sourceId={activeSource.id}
                bundle={bundle as unknown as DataViewSourceBundle<unknown>}
              />
            ),
          } satisfies DataViewSourceProps<THostProps>,
        );
      }}
    </DataViewShellFrame>
  );
}

/**
 * Bridges one source's bundle into the shared `DataViewBody`. Keyed by the
 * source id so switching sources remounts the body (controllers, toolbar
 * state, subscriptions restart); plain instance switches within one source keep
 * the body mounted, exactly like the single-source path.
 */
function MergedSourceBody(props: {
  storageKey: DataViewId;
  viewModel: ReadyViewModel;
  activeInstance: ResolvedViewInstance<DataViewContribution>;
  chrome: DataViewShellChrome;
  sourceId: string;
  bundle: DataViewSourceBundle<unknown>;
}): ReactNode {
  const { storageKey, viewModel, activeInstance, chrome, sourceId, bundle } =
    props;
  return (
    <DataViewBody<unknown>
      key={sourceId}
      {...bundle}
      storageKey={storageKey}
      viewModel={viewModel}
      activeInstance={activeInstance}
      chrome={chrome}
    />
  );
}
