import { MillerColumns } from "@plugins/layouts/plugins/miller/web";
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { FileExplorer } from "../slots";

/**
 * The file explorer: the Places sidebar beside a Miller row — the folder's
 * column, and the open file's preview column beside it, sliding in and out
 * with the row's column motion. Every location is its own route, so back and
 * forward are the browser history.
 *
 * No app toolbar contributes today, so the browser's own toolbar is the
 * surface's top edge and hosts the sidebar toggle.
 */
export function FileExplorerLayout() {
  return (
    // At 1100px and under the sidebar narrows to 200px (the theme's 224px is
    // the wide layout's); at 900px and under it gives way to an open file
    // (the browser marks its preview `data-files-preview`).
    <div className="contents max-[1100px]:[--sidebar-panel-width:12.5rem] max-[900px]:has-data-files-preview:[--sidebar-panel-width:0px] max-[900px]:has-data-files-preview:[&_[data-slot=sidebar-container]]:hidden">
      <AppShellLayout
        sidebarSlot={FileExplorer.Sidebar}
        toolbarSlot={FileExplorer.Toolbar}
      >
        <MillerColumns />
      </AppShellLayout>
    </div>
  );
}
