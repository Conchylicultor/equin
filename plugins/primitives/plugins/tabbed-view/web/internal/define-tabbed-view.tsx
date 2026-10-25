import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType, ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  defineRenderSlot,
  renderIsolated,
  type RenderSlot,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
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
    // reads the slot's layout order rather than `.Render`ing every tab.
    const ordered = useSlotOrder(View);

    const { activeViewId, setActiveView } = useActiveViewId(id);

    const activeView =
      ordered.find((v) => v.id === activeViewId) ?? ordered[0] ?? null;

    return (
      <Column
        fill
        className={className}
        header={
          header != null || ordered.length > 1 ? (
            <Stack gap="xs" className="px-sm pb-xs">
              {header}
              {ordered.length > 1 && activeView && (
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
          activeView &&
          renderIsolated(
            View,
            activeView as unknown as Contribution,
            viewProps as ViewProps,
          )
        }
      />
    );
  }

  return { View, Host };
}
