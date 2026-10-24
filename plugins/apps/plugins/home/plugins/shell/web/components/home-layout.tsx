import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";

/**
 * Home's surface: the sidebar-less app shell around the full-pane renderer, so
 * each of its screens — the launcher (`homeRootPane`) and New app
 * (`new-app`) — fills the tab on its own.
 */
export function HomeLayout() {
  return (
    <AppShellLayout>
      <FullPane />
    </AppShellLayout>
  );
}
