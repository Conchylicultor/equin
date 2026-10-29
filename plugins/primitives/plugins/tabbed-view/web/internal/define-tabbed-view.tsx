import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import type {
  Contribution,
  SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import {
  defineRenderSlot,
  renderIsolated,
  type RenderSlot,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useActiveViewId,
  ViewSwitcher,
} from "@plugins/primitives/plugins/view-switcher/web";

/** What a tab's `useBadge` draws after its title: a count pill. */
export interface TabBadge {
  count: number;
}

export interface TabContribution<ViewProps> {
  id: string;
  title: string;
  icon: IconRef;
  component: ComponentType<ViewProps>;
  /**
   * Gate hook. `false` ⇒ the tab is not in the strip and cannot be active (an
   * active id naming it falls back to the first available tab). Same rule as
   * detail-sections' `useAvailable`: **loading ≠ unavailable** — answer `true`
   * while the fact it decides from is pending, so a tab never pops in late;
   * the tab body shows its own loading state.
   */
  useAvailable?: Hook<(props: ViewProps) => boolean>;
  /** A count drawn after the title (unread messages); `null` ⇒ no badge. */
  useBadge?: Hook<(props: ViewProps) => TabBadge | null>;
}

/** The tab strip's look: ghost pills (default) or an underline tab strip. */
export type TabStrip = "pill" | "underline";

export interface TabbedViewOptions {
  /** Default `"pill"`. */
  strip?: TabStrip;
}

/**
 * Who owns the active tab. Uncontrolled (neither prop): the device-local
 * `useActiveViewId(id)` store. Controlled (`onActiveChange` given): the caller
 * — typically a URL param — and `activeId` is REQUIRED, `undefined` meaning
 * "none named" (the first available tab shows). A controlled host never writes
 * the device store, and never calls `onActiveChange` on its own: an `activeId`
 * naming an unavailable or unknown tab just shows the first available one.
 */
export type TabbedHostSelection =
  | { activeId?: undefined; onActiveChange?: undefined }
  | { activeId: string | undefined; onActiveChange: (id: string) => void };

export type TabbedHostProps<ViewProps> = ViewProps & {
  header?: ReactNode;
  className?: string;
} & TabbedHostSelection;

export interface TabbedView<ViewProps> {
  /** The tabs, in the slot's reorder layout order (`config/<plugin>/<slotId>.jsonc`). */
  View: RenderSlot<TabContribution<ViewProps>>;
  Host: ComponentType<TabbedHostProps<ViewProps>>;
}

interface ProbeSnapshot {
  available: ReadonlyMap<string, boolean>;
  badge: ReadonlyMap<string, TabBadge | null>;
}

/**
 * One host's per-tab hook answers. Hooks can't run in a filter, so each tab's
 * `useAvailable` / `useBadge` runs in its own probe component (the
 * detail-sections gate technique) that reports here from a layout effect — a
 * store write, so the host re-renders before the browser paints.
 */
function createProbeStore() {
  let snapshot: ProbeSnapshot = { available: new Map(), badge: new Map() };
  const listeners = new Set<() => void>();
  function set<K extends keyof ProbeSnapshot>(
    key: K,
    id: string,
    value: ProbeSnapshot[K] extends ReadonlyMap<string, infer V> ? V : never,
  ): void {
    const current = snapshot[key] as ReadonlyMap<string, unknown>;
    if (current.has(id) && current.get(id) === value) return;
    const next = new Map(current);
    next.set(id, value);
    snapshot = { ...snapshot, [key]: next };
    for (const l of listeners) l();
  }
  function remove(key: keyof ProbeSnapshot, id: string): void {
    if (!snapshot[key].has(id)) return;
    const next = new Map(snapshot[key] as ReadonlyMap<string, unknown>);
    next.delete(id);
    snapshot = { ...snapshot, [key]: next };
    for (const l of listeners) l();
  }
  return {
    set,
    remove,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
  };
}
type ProbeStore = ReturnType<typeof createProbeStore>;

export function defineTabbedView<ViewProps extends object>(
  id: string,
  options: TabbedViewOptions = {},
): TabbedView<ViewProps> {
  const strip = options.strip ?? "pill";
  const View = defineRenderSlot<TabContribution<ViewProps>>({
    docLabel: (p) => p.title,
  });

  function AvailabilityProbe({
    tabId,
    useAvailable,
    viewProps,
    store,
  }: {
    tabId: string;
    useAvailable: Hook<(props: ViewProps) => boolean>;
    viewProps: ViewProps;
    store: ProbeStore;
  }): ReactNode {
    const available = useAvailable(viewProps);
    useLayoutEffect(() => {
      store.set("available", tabId, available);
    }, [store, tabId, available]);
    useLayoutEffect(
      () => () => store.remove("available", tabId),
      [store, tabId],
    );
    return null;
  }

  function BadgeProbe({
    tabId,
    useBadge,
    viewProps,
    store,
  }: {
    tabId: string;
    useBadge: Hook<(props: ViewProps) => TabBadge | null>;
    viewProps: ViewProps;
    store: ProbeStore;
  }): ReactNode {
    const badge = useBadge(viewProps);
    const count = badge?.count;
    useLayoutEffect(() => {
      store.set("badge", tabId, count === undefined ? null : { count });
    }, [store, tabId, count]);
    useLayoutEffect(() => () => store.remove("badge", tabId), [store, tabId]);
    return null;
  }

  function Host(props: TabbedHostProps<ViewProps>): ReactNode {
    const { header, className, activeId, onActiveChange, ...viewProps } = props;
    // The host draws its own switcher and mounts only the active tab, so it
    // reads the slot's layout order rather than `.Render`ing every tab. That
    // order is a read: until it is known the SAME column renders the caller's
    // header (no switcher) over a loading body — never the tabs in raw
    // registration order — so the header does not remount when it settles. A
    // failed refresh keeps the last-known order.
    const order = useSlotOrder(View);
    const ordered = foldResource(order, {
      loading: ():
        readonly SealContributions<TabContribution<ViewProps>>[] | null => null,
      error: (_error, stale) => stale ?? null,
      ready: (list) => list,
    });

    const stored = useActiveViewId(id);
    const [store] = useState(createProbeStore);
    const probes = useSyncExternalStore(store.subscribe, store.getSnapshot);

    // A gated tab whose probe has not reported yet exists only for the render
    // before the probes' layout effects — never painted. It counts as shown
    // (pending = shown, the useAvailable rule), but the BODY waits for every
    // gate, so a tab that turns out unavailable is never mounted.
    const gatesSettled =
      ordered !== null &&
      ordered.every((v) => !v.useAvailable || probes.available.has(v.id));
    const visible =
      ordered?.filter((v) => probes.available.get(v.id) ?? true) ?? null;

    const requested =
      onActiveChange !== undefined ? activeId : stored.activeViewId;
    const activeView =
      visible === null
        ? null
        : (visible.find((v) => v.id === requested) ?? visible[0] ?? null);
    const select = onActiveChange ?? stored.setActiveView;
    const switcher = visible !== null && visible.length > 1;

    const switcherNode =
      switcher && activeView ? (
        <ViewSwitcher
          options={visible.map((v) => ({
            id: v.id,
            title: v.title,
            icon: v.icon,
            count: probes.badge.get(v.id)?.count,
          }))}
          activeId={activeView.id}
          onSelect={select}
          variant={strip}
        />
      ) : null;
    const bodyNode =
      ordered === null ? (
        order.status === "error" ? (
          <ResourceErrorInline
            error={order.error}
            refetch={order.refetch}
            variant="block"
          />
        ) : (
          <Loading />
        )
      ) : (
        gatesSettled &&
        activeView &&
        renderIsolated(
          View,
          activeView as unknown as Contribution,
          viewProps as ViewProps,
        )
      );
    const probeNodes = ordered?.map((v) => (
      <TabProbes
        key={v.id}
        tab={v}
        viewProps={viewProps as ViewProps}
        store={store}
      />
    ));

    // An underline strip is a PAGE's section tabs: the whole page scrolls —
    // header, strip and tab body in one scroll — and the strip pins to the
    // top as it reaches it (`Sticky`, masked so the body scrolls under it).
    // The strip is a direct child of the scrolled block, so it stays pinned
    // for the page's whole length rather than only past its header.
    if (strip === "underline") {
      return (
        <>
          {probeNodes}
          <Column
            fill
            className={className}
            hideScrollbar
            body={
              <>
                {header != null ? (
                  <Inset b={switcherNode ? "lg" : "none"}>{header}</Inset>
                ) : null}
                {switcherNode ? <Sticky mask>{switcherNode}</Sticky> : null}
                <Inset t={switcherNode ? "lg" : "none"}>{bodyNode}</Inset>
              </>
            }
          />
        </>
      );
    }

    return (
      <>
        {probeNodes}
        <Column
          fill
          className={className}
          header={
            header != null || switcherNode ? (
              // A pill strip sits inset in a pane, fixed over the scrolling
              // tab body.
              <Stack gap="xs" className="px-sm pb-xs">
                {header}
                {switcherNode}
              </Stack>
            ) : undefined
          }
          hideScrollbar
          body={bodyNode}
        />
      </>
    );
  }

  /** A tab's probes. Hook presence is stable per contribution, so branching is rules-of-hooks clean. */
  function TabProbes({
    tab,
    viewProps,
    store,
  }: {
    tab: Pick<TabContribution<ViewProps>, "id" | "useAvailable" | "useBadge">;
    viewProps: ViewProps;
    store: ProbeStore;
  }): ReactNode {
    return (
      <>
        {tab.useAvailable && (
          <AvailabilityProbe
            tabId={tab.id}
            useAvailable={tab.useAvailable}
            viewProps={viewProps}
            store={store}
          />
        )}
        {tab.useBadge && (
          <BadgeProbe
            tabId={tab.id}
            useBadge={tab.useBadge}
            viewProps={viewProps}
            store={store}
          />
        )}
      </>
    );
  }

  return { View, Host };
}
