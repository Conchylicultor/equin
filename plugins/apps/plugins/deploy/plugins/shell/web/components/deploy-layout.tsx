import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { Deploy } from "../slots";

/**
 * The Deploy app: the sidebar (sites, servers, …) beside one full-surface
 * page. Every page — the sites index, a site, a server — is its own route, so
 * `FullPane` paints the current one and back/forward are the browser history.
 */
export function DeployLayout() {
  return (
    <AppShellLayout sidebarSlot={Deploy.Sidebar}>
      <FullPane />
    </AppShellLayout>
  );
}
