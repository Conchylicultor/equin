import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  useOpenPane,
  usePaneMatch,
} from "@plugins/primitives/plugins/pane/web";
import type {
  AppShellSidebarItem,
  AppShellSidebarNav,
  SidebarNavTarget,
} from "./app-shell-layout";

/**
 * Renders one sidebar-slot contribution: a nav entry through the shell's own
 * row, a custom region as its component. `AppShellLayout` renders its sidebar
 * slot through this, and so must any other host that paints a sidebar slot
 * (e.g. the Pages tree pane) — so an entry looks the same wherever it appears.
 */
export function SidebarItem(item: AppShellSidebarItem) {
  if (item.component) {
    const Comp = item.component;
    return <Comp />;
  }
  if (item.opens) return <SidebarNavOpensItem {...item} target={item.opens} />;
  return <SidebarNavRow {...item} onClick={item.onClick} isActive={false} />;
}

/**
 * The `opens` arm: opens its pane as the route root, and is active while the
 * surface's root pane is that pane. A component of its own so only these rows
 * read the route (an `onClick` row neither needs it nor re-renders with it).
 *
 * Read off the surface's MATCH, not the raw route: at the app's bare root the
 * route is empty and the match is the app's index pane, so an entry opening
 * the index is current there. An index pane is the parent of every pane opened
 * from scratch below it (it owns no URL segment, so it heads their chain), so
 * its entry is current only while nothing but companions follows it — else the
 * landing entry would stay lit beside the entry of whatever was opened under it.
 */
function SidebarNavOpensItem({
  target,
  ...item
}: AppShellSidebarNav & { target: SidebarNavTarget }) {
  const panes = usePaneMatch()?.panes ?? [];
  const openPane = useOpenPane();
  const root = panes[0]?.pane;
  const isActive =
    root === target.pane._internal &&
    (!root.appIndex || panes.slice(1).every((p) => p.pane.companion));
  return (
    <SidebarNavRow
      {...item}
      isActive={isActive}
      {...openPane.link(target.pane, target.params, { mode: "root" })}
    />
  );
}

/**
 * The one rendering of a sidebar nav entry. The shell draws every
 * `AppShellSidebarNav` contribution through this, so two nav rows cannot differ
 * in inset, height, icon size or hover — a contributor supplies data, never
 * chrome. The rail inset comes from `SidebarMenu` itself (`rail-follow`), not
 * from a class written here; the row's height, padding, icon size and icon
 * gap are the sidebar-metrics theme tokens, and its label is the `label` type
 * role (both through `SidebarMenuButton`).
 *
 * The icon wears `--sidebar-icon` at rest (the row's own text colour unless a
 * theme quiets it) and the row's text colour while the row is hovered or
 * active.
 */
function SidebarNavRow({
  icon,
  title,
  badge: Badge,
  isActive,
  onClick,
  onAuxClick,
  onMouseDown,
}: Pick<AppShellSidebarNav, "icon" | "title" | "badge"> &
  // The row's click gesture: a plain `onClick`, or a pane link's click /
  // aux-click / mousedown trio (see primitives/link-gesture).
  Pick<
    React.ComponentProps<"button">,
    "onClick" | "onAuxClick" | "onMouseDown"
  > & {
    isActive: boolean;
  }) {
  const iconClass =
    "size-sidebar-icon text-sidebar-icon group-hover/menu-button:text-current group-data-active/menu-button:text-current";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={onClick}
          onAuxClick={onAuxClick}
          onMouseDown={onMouseDown}
          isActive={isActive}
        >
          {Badge ? (
            <span className="relative">
              <Icon icon={icon} active={isActive} className={iconClass} />
              <Pin to="top-right" offset="2xs" outset decorative>
                <Badge />
              </Pin>
            </span>
          ) : (
            <Icon icon={icon} active={isActive} className={iconClass} />
          )}
          <span>{title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
