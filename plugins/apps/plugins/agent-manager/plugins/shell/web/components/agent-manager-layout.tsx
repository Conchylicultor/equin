import { MillerColumns } from "@plugins/layouts/plugins/miller/web";
import { AppShellLayout } from "@plugins/primitives/plugins/app-shell/web";
import { Shell } from "@plugins/shell/web";
import { AGENT_MANAGER_READY_ATTR } from "../../core";

/**
 * The agent manager: the shell sidebar around Miller columns. The sidebar's
 * header is the shared app brand (AppShell.Brand); the sidebar-collapse
 * trigger lives in the first miller column's header (provided by
 * AppShellLayout via SurfaceChromeContext), and Cmd/Ctrl+B toggles it.
 * The columns' box carries the ready marker scripts wait on
 * (`AGENT_MANAGER_READY`).
 */
export function AgentManagerLayout() {
  return (
    <AppShellLayout sidebarSlot={Shell.Sidebar}>
      <div className="h-full min-h-0" {...{ [AGENT_MANAGER_READY_ATTR]: "" }}>
        <MillerColumns />
      </div>
    </AppShellLayout>
  );
}
