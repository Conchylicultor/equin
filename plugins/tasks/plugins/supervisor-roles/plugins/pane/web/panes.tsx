import type { ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  Pane,
  PaneChrome,
  resolveFrom,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { PLAIN_GESTURE } from "@plugins/primitives/plugins/link-gesture/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { supervisorRoles } from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  supervisorRoleRoute,
  supervisorsRoute,
  supervisorsSharedRoute,
} from "../core";
import { SupervisorsList } from "./components/supervisors-list";
import { RoleDetail } from "./components/role-detail";
import { SharedDetail } from "./components/shared-detail";

// Panes are declared first so their types are known before the component
// bodies reference them (the bodies are hoisted function declarations).

export const supervisorsPane = Pane.define({
  title: "Supervisors",
  route: supervisorsRoute,
  app: agentManagerApp,
  component: SupervisorsBody,
});

function useResolveRole({ roleId }: { roleId: string }): ResolveResult {
  return resolveFrom(useLive(supervisorRoles), (roles) =>
    roles.some((r) => r.id === roleId),
  );
}

/** The role's name, once the roles are known. */
function useRoleTitle({ roleId }: { roleId: string }): string | undefined {
  return foldResource(useLive(supervisorRoles), {
    loading: () => undefined,
    error: () => undefined,
    ready: (roles) => roles.find((r) => r.id === roleId)?.name,
  });
}

// One role (/agents/supervisors/role/<id>): every setting inline, its
// session, its backlog and its session history.
export const supervisorRolePane = Pane.define({
  route: supervisorRoleRoute,
  app: agentManagerApp,
  useResolve: useResolveRole,
  title: { useText: useRoleTitle },
  component: SupervisorRoleBody,
});

// The pinned "All supervisors" entry: the shared prompt.
export const supervisorsSharedPane = Pane.define({
  title: "All supervisors",
  route: supervisorsSharedRoute,
  app: agentManagerApp,
  component: SupervisorsSharedBody,
});

function SupervisorsBody(): ReactElement {
  const openPane = useOpenPane();
  const roleId = supervisorRolePane.useRouteEntry()?.params.roleId;
  const shared = supervisorsSharedPane.useRouteEntry() !== undefined;
  return (
    <PaneChrome pane={supervisorsPane}>
      <div className="rail-lg">
        <SupervisorsList
          selected={shared ? "all" : roleId}
          linkToRole={(id) =>
            openPane.to(supervisorRolePane, { roleId: id }, { mode: "push" })
          }
          linkToShared={() =>
            openPane.to(supervisorsSharedPane, {}, { mode: "push" })
          }
          onCreated={(id) =>
            openPane
              .to(supervisorRolePane, { roleId: id }, { mode: "push" })
              .open(PLAIN_GESTURE)
          }
        />
      </div>
    </PaneChrome>
  );
}

function SupervisorRoleBody(): ReactElement {
  const { roleId } = supervisorRolePane.useParams();
  const openPane = useOpenPane();
  return (
    <PaneChrome pane={supervisorRolePane}>
      <RoleDetail
        roleId={roleId}
        linkToShared={() =>
          openPane.to(supervisorsSharedPane, {}, { mode: "push" })
        }
      />
    </PaneChrome>
  );
}

function SupervisorsSharedBody(): ReactElement {
  return (
    <PaneChrome pane={supervisorsSharedPane}>
      <SharedDetail />
    </PaneChrome>
  );
}
