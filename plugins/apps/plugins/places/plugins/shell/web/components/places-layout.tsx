import { FullPane } from "@plugins/layouts/plugins/full-pane/web";
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";

/**
 * The Places app's surface: the standard sidebar-less app shell around the
 * full-pane renderer. The shell registers no pane of its own — the map
 * registers the app's index pane, which fills the surface edge to edge.
 */
export function PlacesLayout() {
  return (
    <AppShellLayout>
      <FullPane />
    </AppShellLayout>
  );
}
