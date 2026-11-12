import {
  cn,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useInSidebarPanel,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactNode } from "react";
import {
  CollapsibleChevron,
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";

type HeaderPayload = { label?: string; collapsed?: boolean };

/**
 * The `header` container node type's box: a labeled, collapsible frame that
 * renders its pre-rendered members as `children`. Visual style mirrors the old
 * group box (border + chevron header row) but without the drag handle, rename
 * input, delete button, or any endpoint/DB calls — collapse is the only
 * affordance, written back through `onPatch`. Label is display-only this pass.
 *
 * Inside a sidebar panel (`useInSidebarPanel`) it drops the frame and draws as
 * a sidebar row instead (see below), so a sidebar layout can fold entries away.
 */
export function HeaderBox({
  payload,
  editMode: _editMode,
  onPatch,
  children,
}: {
  payload: HeaderPayload;
  editMode: boolean;
  onPatch: (next: Partial<HeaderPayload>) => void;
  children: ReactNode;
}) {
  const inSidebar = useInSidebarPanel();
  const { open, triggerProps, contentProps } = useCollapsible({
    open: !(payload.collapsed ?? false),
    onOpenChange: (next) => onPatch({ collapsed: !next }),
  });

  // In a sidebar panel the group is one of the sidebar's own rows — the
  // chevron in the icon column, the label muted — and its members fold in
  // below at the sidebar's rail, with no frame: a "More" that tucks
  // secondary nav entries away, not a card in the middle of the list.
  if (inSidebar) {
    return (
      <>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              {...triggerProps}
              className="text-sidebar-foreground/70"
            >
              <CollapsibleChevron
                open={open}
                className="size-sidebar-icon text-sidebar-icon group-hover/menu-button:text-current"
              />
              <span>{payload.label || "Group"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <FoldMotion {...contentProps}>{children}</FoldMotion>
      </>
    );
  }

  return (
    <div className="rounded-md border border-border/50">
      <Line className="gap-2xs px-xs py-xs">
        <button
          {...triggerProps}
          aria-label={open ? "Collapse" : "Expand"}
          className={cn(
            rigidClass(),
            "size-4 rounded-sm text-muted-foreground hover:text-foreground",
          )}
        >
          <Center className="size-full">
            <CollapsibleChevron open={open} className="size-3.5" />
          </Center>
        </button>
        <Text
          variant="caption"
          tone={payload.label ? "default" : "muted"}
          className={cn("truncate", !payload.label && "italic")}
        >
          {payload.label || "Group"}
        </Text>
      </Line>
      <FoldMotion {...contentProps}>
        <Inset x="xs" b="xs">
          {children}
        </Inset>
      </FoldMotion>
    </div>
  );
}
