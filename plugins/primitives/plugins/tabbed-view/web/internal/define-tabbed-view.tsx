import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType, ReactNode } from "react";
import type {
  Contribution,
  SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
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

export interface TabContribution<ViewProps> {
  id: string;
  title: string;
  icon: IconRef;
  component: ComponentType<ViewProps>;
}

export interface TabbedView<ViewProps> {
  /** The tabs, in the slot's reorder layout order (`config/<plugin>/<slotId>.jsonc`). */
  View: RenderSlot<TabContribution<ViewProps>>;
  Host: ComponentType<ViewProps & { header?: ReactNode; className?: string }>;
}

export function defineTabbedView<ViewProps extends object>(
  id: string,
): TabbedView<ViewProps> {
  const View = defineRenderSlot<TabContribution<ViewProps>>({
    docLabel: (p) => p.title,
  });

  function Host(
    props: ViewProps & { header?: ReactNode; className?: string },
  ): ReactNode {
    const { header, className, ...viewProps } = props;
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

    const { activeViewId, setActiveView } = useActiveViewId(id);

    const activeView =
      ordered === null
        ? null
        : (ordered.find((v) => v.id === activeViewId) ?? ordered[0] ?? null);
    const switcher = ordered !== null && ordered.length > 1;

    return (
      <Column
        fill
        className={className}
        header={
          header != null || switcher ? (
            <Stack gap="xs" className="px-sm pb-xs">
              {header}
              {switcher && activeView && (
                <ViewSwitcher
                  options={ordered.map((v) => ({
                    id: v.id,
                    title: v.title,
                    icon: v.icon,
                  }))}
                  activeId={activeView.id}
                  onSelect={setActiveView}
                />
              )}
            </Stack>
          ) : undefined
        }
        hideScrollbar
        body={
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
            activeView &&
            renderIsolated(
              View,
              activeView as unknown as Contribution,
              viewProps as ViewProps,
            )
          )
        }
      />
    );
  }

  return { View, Host };
}
