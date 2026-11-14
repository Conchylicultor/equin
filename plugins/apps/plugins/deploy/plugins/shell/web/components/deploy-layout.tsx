import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { MillerColumns } from "@plugins/layouts/plugins/miller/web";
import { Deploy } from "../slots";

/**
 * The Deploy app: the sidebar (sites, servers, …) beside its pages as Miller
 * columns. Every page — the sites index, a site, a server — opens as a root
 * route, so it is one column filling the surface; a pane pushed from one (a
 * session's replay beside its site) opens as a column to its right.
 */
export function DeployLayout() {
  return (
    <AppShellLayout sidebarSlot={Deploy.Sidebar}>
      <MillerColumns />
    </AppShellLayout>
  );
}
