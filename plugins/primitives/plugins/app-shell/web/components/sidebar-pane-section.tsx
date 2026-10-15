import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { type ComponentType, type ReactNode } from "react";
import {
  useCollapsible,
  CollapsibleChevron,
  FoldMotion,
} from "@plugins/primitives/plugins/collapsible/web";

export function SidebarPaneSection({
  icon,
  title,
  labelExtra: LabelExtra,
  defaultOpen = true,
  children,
}: {
  icon: IconRef;
  title: string;
  labelExtra?: ComponentType;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { open, triggerControlProps, contentProps } = useCollapsible({
    defaultOpen,
  });
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- shadcn SidebarGroup is the flex-column clip container for a collapsible section; flex/min-h-0/overflow-hidden configure the third-party component's own box, not a primitive boundary
    <SidebarGroup className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SidebarGroupLabel
        // eslint-disable-next-line layout/no-adhoc-layout -- shrink-0 keeps the label row rigid inside shadcn SidebarGroup's flex column
        className="group/label shrink-0 cursor-pointer select-none hover:text-sidebar-foreground"
        {...triggerControlProps}
      >
        {/* eslint-disable-next-line spacing/no-adhoc-spacing -- one-off icon offset inside shadcn SidebarGroupLabel label row */}
        <Icon icon={icon} className="mr-2 size-4" />
        {title}
        {LabelExtra && <LabelExtra />}
        <CollapsibleChevron open={open} className="ml-auto size-4" />
      </SidebarGroupLabel>
      <FoldMotion
        {...contentProps}
        // eslint-disable-next-line layout/no-adhoc-layout -- the fold box is the section's flexible cell in SidebarGroup's flex column (the fold caps its height, so its siblings take the room back as it closes); the body inside fills it
        className="flex min-h-0 flex-1 flex-col"
      >
        <SidebarGroupContent
          // eslint-disable-next-line layout/no-adhoc-layout -- shadcn SidebarGroupContent is the flexible scrolling body of the section; flex/min-h-0/overflow-hidden configure the third-party component's own box
          className="min-h-0 flex flex-1 flex-col overflow-hidden"
        >
          {children}
        </SidebarGroupContent>
      </FoldMotion>
    </SidebarGroup>
  );
}
