import { type CSSProperties, type ReactNode, useMemo } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  Sticky,
  stickyOffsetPx,
} from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  DATA_VIEW_HEADER_OFFSET_VAR,
  type CreateOption,
  type DataViewDensity,
  type DataViewGroupHeaders,
  type DataViewId,
  type DataViewProps,
  type DataViewReserve,
  type DataViewToolbarSpec,
  isHostedToolbar,
  isSectionsToolbar,
} from "../../core";
import {
  CollapsedViewSwitcher,
  EditableViewSwitcher,
  type ResolvedViewInstance,
} from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import type { ViewSourceEntry } from "@plugins/primitives/plugins/data-view/plugins/view-core/core";
import { DataViewSlots, type DataViewContribution } from "../slots";
import {
  useDataViewModel,
  type ReadyViewModel,
  type ViewModel,
} from "../internal/use-data-view-model";
import type { DataViewShellChrome } from "../internal/body-types";
import { useDataViewDevGuards } from "../internal/use-dev-guards";
import { useOrphanViewTypeGuard } from "../internal/use-orphan-view-type-guard";
import { hoverRevealGroup } from "@plugins/primitives/plugins/hover-reveal/web";
import { CreatorsControl, hostedCreators } from "./creators-control";
import { DataViewBody, DataViewSectionsBody } from "./data-view-body";

/**
 * Host entry point. Every DataView is config-backed (config mode is universal):
 * its `storageKey` is a `defineDataView` id with a centrally-registered
 * `viewsDescriptor`, so the host always builds the config-backed `ViewModel`
 * (config-authored instances, full instance actions, durable per-instance
 * sort/filter written back to the config row) and renders the editable
 * view-switcher.
 *
 * Split as shell + body: the shell (this file) owns the per-surface concerns —
 * the view model, the switcher, the placeholder branch, the dev guards, and the
 * toolbar-height measurement — while `DataViewBody` owns everything downstream
 * of "which instance is active" (the field-extension fold, the data plumbing,
 * the sort/filter controllers, the toolbar, the view render).
 */
export function DataView<TRow>(props: DataViewProps<TRow>): ReactNode {
  const contributions = DataViewSlots.View.useContributions();
  // The single-source path is ONE implicit source entry (`id`/`title`
  // undefined): every config row (all source-less) resolves through it, and the
  // add menu stays the flat single-group fast path.
  const { views, viewOptions } = props;
  const onOrphanType = useOrphanViewTypeGuard(contributions);
  const entries = useMemo<ViewSourceEntry<DataViewContribution>[]>(
    () => [{ contributions, views, viewOptions, onOrphanType }],
    [contributions, views, viewOptions, onOrphanType],
  );
  const viewModel = useDataViewModel(
    props.storageKey,
    entries,
    props.defaultView,
    props.pinnedView,
  );
  return (
    <DataViewShellFrame
      storageKey={props.storageKey}
      viewModel={viewModel}
      title={props.title}
      actions={props.actions}
      creators={props.creators}
      density={props.density}
      groupHeaders={props.groupHeaders}
      toolbar={props.toolbar}
      searchPlaceholder={props.searchPlaceholder}
      aside={props.aside}
      backdrop={props.backdrop}
      reserve={props.reserve}
      pinnedView={props.pinnedView}
      renderSections={(instances, chrome, readyModel) => (
        <DataViewSectionsBody<TRow>
          {...props}
          viewModel={readyModel}
          instances={instances}
          chrome={chrome}
        />
      )}
    >
      {(activeInstance, chrome, readyModel) => (
        <DataViewBody<TRow>
          {...props}
          viewModel={readyModel}
          activeInstance={activeInstance}
          chrome={chrome}
        />
      )}
    </DataViewShellFrame>
  );
}

/**
 * The shared per-surface shell frame: dev guards, the root sticky containing
 * block + `--dv-header-offset` publication, the editable switcher, and the
 * zero-instances placeholder branch. `children` renders the per-active-instance
 * body — it is invoked as a plain function (not a component), so it must stay
 * hook-free; the body's hooks live in `DataViewBody`'s own components.
 *
 * Shared by the single-source `DataView` above and `DataViewSwitcher` (exported
 * plugin-internally, never from the barrel) so the placeholder / measurement /
 * switcher logic cannot drift between the two hosts.
 */
export function DataViewShellFrame(props: {
  storageKey: DataViewId;
  viewModel: ViewModel;
  title?: ReactNode;
  actions?: ReactNode;
  creators?: CreateOption[];
  density?: DataViewDensity;
  groupHeaders?: DataViewGroupHeaders;
  toolbar?: DataViewToolbarSpec;
  searchPlaceholder?: string;
  /** The surface's side panel (`DataViewProps.aside`); the body places it. */
  aside?: ReactNode;
  /** The surface's backdrop view type (`DataViewProps.backdrop`). */
  backdrop?: string;
  /** The room the surface's own chrome covers (`DataViewProps.reserve`). */
  reserve?: DataViewReserve;
  /** Present → this host shows one named instance and paints no switcher. */
  pinnedView?: string;
  /** Renders the per-active-instance body. Receives the SETTLED model — the
   *  shell is the one place that narrowed the union, so a host never re-derives
   *  (or forgets) that narrowing at its own call site. */
  children: (
    activeInstance: ResolvedViewInstance<DataViewContribution>,
    chrome: DataViewShellChrome,
    viewModel: ReadyViewModel,
  ) => ReactNode;
  /**
   * Renders EVERY instance, stacked — what a `{ kind: "sections" }` toolbar
   * shows instead of `children`'s one active instance. Only the single-source
   * `DataView` passes it: `DataViewSwitcher` cannot take a sections toolbar (its
   * props exclude it), so its absence there is unreachable, and a sections
   * toolbar without it throws rather than silently rendering one section.
   */
  renderSections?: (
    instances: readonly ResolvedViewInstance<DataViewContribution>[],
    chrome: DataViewShellChrome,
    viewModel: ReadyViewModel,
  ) => ReactNode;
}): ReactNode {
  const {
    storageKey,
    viewModel,
    title,
    actions,
    creators,
    density,
    groupHeaders,
    toolbar,
    searchPlaceholder,
    aside,
    backdrop,
    reserve,
    pinnedView,
    children,
    renderSections,
  } = props;

  // DataView is always natural-height and never owns a scroller — the pane owns
  // exactly one scroll (via `<PaneScroll>`). Dev-only structural guard fires if
  // the enclosing pane forgot to provide that scroll (kept in its own hook so the
  // effect's DOM walk stays out of this component's React Compiler analysis).
  const rootRef = useDataViewDevGuards(storageKey);

  // Measure the sticky toolbar's height and publish it on the root as
  // `--dv-header-offset` (see `DATA_VIEW_HEADER_OFFSET_VAR`). Grouped views stack
  // their sticky group headers directly below the toolbar by reading this var, so
  // two stacked sticky bands never overlap regardless of the toolbar's (dynamic)
  // height. Mirrors the `--chrome-mask` cross-plugin CSS-var convention. The ref
  // crosses into the body, which attaches it to the toolbar's `<Sticky>`.
  const [toolbarRef, { height: toolbarHeight }] = useElementSize();

  // The surface's own views are not known yet (the config document has not
  // arrived — a cold boot whose snapshot failed, a WS still catching up). We
  // cannot say whether this surface has views, so we say exactly that: a
  // skeleton, not an answer. Rendering the "No views configured" branch here is
  // what used to make a DataView state, confidently and wrongly, that a fully
  // configured surface had nothing in it for the seconds before its config
  // landed. `Loading` fades in only after ~120ms, so the normal (already
  // hydrated) case still paints nothing at all.
  // A hosted toolbar has no band: the surface's own frame is the header, in
  // every state (so the card does not reflow as the config settles), and the
  // root is the options trigger's hover-reveal group — the band that anchors it
  // otherwise does not exist.
  const hosted = isHostedToolbar(toolbar);
  // Sections: no band and no frame — every instance under its own header, so
  // a state with no instance is just its content.
  const sectioned = isSectionsToolbar(toolbar);
  // An overlay arrangement floats its band over the view, which takes the
  // whole surface: the root fills its parent's height (instead of growing to
  // its content) and is the positioning context the band and aside float in.
  const overlay = !hosted && !sectioned && toolbar?.overlay === true;
  const rootClassName = hosted
    ? hoverRevealGroup
    : overlay
      ? "relative h-full"
      : undefined;
  if (aside !== undefined && (hosted || sectioned)) {
    throw new Error(
      `DataView(${storageKey}): \`aside\` needs a band toolbar — a hosted ` +
        "or sections toolbar has no band to place it beside.",
    );
  }
  if (backdrop !== undefined && !overlay) {
    throw new Error(
      `DataView(${storageKey}): \`backdrop\` needs an overlay toolbar ` +
        "arrangement — only a band floating over the view leaves the view " +
        "a canvas to stay under every other view.",
    );
  }
  if (reserve !== undefined && backdrop === undefined) {
    throw new Error(
      `DataView(${storageKey}): \`reserve\` moves the floating view card ` +
        "of a `backdrop` surface — without a backdrop there is no card.",
    );
  }
  // The chrome of a state with no active instance (loading, or no views
  // authored): the band's stand-in toolbar, or the hosted frame without its
  // options — there is no instance for them to act on yet.
  const withoutInstance = (content: ReactNode): ReactNode =>
    sectioned ? (
      <Stack gap="none" ref={rootRef}>
        <div className="rail-follow py-md">{content}</div>
      </Stack>
    ) : hosted ? (
      <Stack gap="none" ref={rootRef} className={rootClassName}>
        <toolbar.frame
          options={null}
          switcher={null}
          creators={hostedCreators(creators)}
          body={content}
          stickyRef={toolbarRef}
        />
      </Stack>
    ) : (
      <Stack gap="none" ref={rootRef} className={rootClassName}>
        <ShellToolbar title={title} actions={actions} creators={creators} />
        <div className="rail-follow py-md">{content}</div>
      </Stack>
    );

  if (!viewModel.ready) {
    const { failure } = viewModel;
    return withoutInstance(
      failure === null ? (
        <Loading variant="rows" />
      ) : (
        <ResourceErrorInline
          variant="block"
          error={failure.error}
          refetch={failure.refetch}
          subject="this view's configuration"
        />
      ),
    );
  }

  const { instances, activeId } = viewModel;

  if (sectioned) {
    if (!renderSections) {
      throw new Error(
        `DataView(${storageKey}): a sections toolbar needs a host that ` +
          "renders every instance — DataViewSwitcher cannot.",
      );
    }
    if (instances.length === 0) {
      return withoutInstance(
        <Placeholder>
          No views configured — author{" "}
          <code>config/&lt;plugin&gt;/{storageKey}.jsonc</code>
        </Placeholder>,
      );
    }
    // No switcher (every instance is on screen) and no band to measure: each
    // section publishes its own header's height to the views inside it, so
    // the root's offset stays the `0px` of an unattached `stickyRef`.
    const sectionsChrome: DataViewShellChrome = {
      switcher: { strip: null, chip: null },
      switcherCount: instances.length,
      density,
      groupHeaders,
      toolbar,
      searchPlaceholder,
      stickyRef: toolbarRef,
    };
    return (
      <Stack gap="none" ref={rootRef}>
        {renderSections(instances, sectionsChrome, viewModel)}
      </Stack>
    );
  }

  const pinned = pinnedView !== undefined;
  const matched = instances.find((r) => r.instance.id === activeId) ?? null;
  // The first-instance fallback is for an UNPINNED surface, whose active id can
  // legitimately be stale (a renamed instance, a device that never chose one).
  // A pinned surface must not have it: `resolveActiveId` returns "" precisely to
  // say "the pinned instance is not authored", and falling through to
  // `instances[0]` would answer that by rendering someone else's tab — the exact
  // silent-wrong-list failure pinning exists to prevent, and invisible on any
  // surface that has instances at all.
  const activeInstance = pinned ? matched : (matched ?? instances[0] ?? null);

  const activeViewId = activeInstance?.instance.id ?? "";

  // Config is the single source of truth: zero authored view-instances → render
  // an honest placeholder rather than an empty shell. Reachable ONLY once the
  // config is known (the branch above), so this claim is always true when it is
  // made. The build-time `config:overrides-authored` check is the real forcing
  // function (the views descriptor sets `requiresAuthoredOverride`, so the build
  // seeds the config and marks it for review); this keeps the pane from crashing
  // if a config is authored-but-empty. Early-returning here (before the body
  // mounts) is the body's only gate.
  if (!activeInstance) {
    return withoutInstance(
      <Placeholder>
        {pinned ? (
          <>
            No view instance <code>{pinnedView}</code> in{" "}
            <code>config/&lt;plugin&gt;/{storageKey}.jsonc</code>
          </>
        ) : (
          <>
            No views configured — author{" "}
            <code>config/&lt;plugin&gt;/{storageKey}.jsonc</code>
          </>
        )}
      </Placeholder>,
    );
  }

  // The switcher needs only model inputs, so the shell builds both of its forms
  // once per surface and the toolbar places one of them as an opaque node.
  const switcherInputs = {
    instances,
    activeId: activeViewId,
    onSelect: viewModel.setActiveView,
    actions: viewModel.actions,
  };
  const chrome: DataViewShellChrome = {
    // A pinned host paints NO switcher — the nodes themselves, not just its
    // count. `switcherCount` gates only the COMPACT toolbar (`switcherCount >
    // 1`); a wide arrangement renders a switcher unconditionally, so a count of
    // 1 alone would leave a wide pinned surface showing a live switcher, whose
    // clicks write a shared selection this host then ignores — a dead switcher,
    // which is worse than the shared-selection problem pinning solves.
    switcher: pinned
      ? { strip: null, chip: null }
      : {
          strip: <EditableViewSwitcher {...switcherInputs} />,
          chip: (
            <CollapsedViewSwitcher
              {...switcherInputs}
              // Only a hosted frame picks the switcher's form; a band
              // arrangement places today's chip.
              appearance={hosted ? (toolbar.forms?.switcher ?? "chip") : "chip"}
            />
          ),
        },
    switcherCount: pinned ? 1 : instances.length,
    title,
    actions,
    density,
    groupHeaders,
    toolbar,
    searchPlaceholder,
    stickyRef: toolbarRef,
    aside,
    backdrop,
    reserve,
  };

  return (
    // `Stack gap="none"` = a plain `flex flex-col` block box (no `min-h-0 flex-1`)
    // that establishes this DataView's own sticky containing block and lets the
    // body grow to natural height — the pane (via `<PaneScroll>`) owns the scroll.
    <Stack
      gap="none"
      ref={rootRef}
      className={rootClassName}
      // Publish the measured sticky-toolbar height so grouped views stack their
      // own sticky group headers directly below it (see DATA_VIEW_HEADER_OFFSET_VAR).
      style={
        {
          [DATA_VIEW_HEADER_OFFSET_VAR]: `${stickyOffsetPx(toolbarHeight)}px`,
        } as CSSProperties
      }
    >
      {children(activeInstance, chrome, viewModel)}
    </Stack>
  );
}

/**
 * The toolbar the shell paints while it has no active instance to render a body
 * for — shared by the loading and the confirmed-empty branches so the surface's
 * chrome (title, actions, create affordances) does not appear, disappear and
 * reappear as the config settles. The real toolbar (switcher + controls) lives
 * in `DataViewBody`, which only mounts once an instance exists.
 */
function ShellToolbar(props: {
  title?: ReactNode;
  actions?: ReactNode;
  creators?: CreateOption[];
}): ReactNode {
  const { title, actions, creators } = props;
  return (
    <Sticky
      edge="top"
      // eslint-disable-next-line layout/no-adhoc-layout -- horizontal toolbar row of variable-content controls; no named-slot primitive maps
      className="bg-background flex items-center gap-sm py-sm rail-follow"
    >
      {title ? (
        <Text as="div" variant="label">
          {title}
        </Text>
      ) : null}
      {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- surface-level toolbar actions, one per DataView, not a per-row cluster */}
      {actions ? <div className="ml-auto">{actions}</div> : null}
      <div className={actions ? undefined : "ml-auto"}>
        <CreatorsControl creators={creators} />
      </div>
    </Sticky>
  );
}
