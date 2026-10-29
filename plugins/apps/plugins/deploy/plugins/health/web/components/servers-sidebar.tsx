import { useMemo, type ReactElement, type ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  matchResource,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { SidebarPaneSection } from "@plugins/primitives/plugins/app-shell/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  NEW_SERVER_ID,
  serverDetailPane,
  servers,
  type ServerListRow,
} from "@plugins/apps/plugins/deploy/plugins/servers/web";
import type { ServerHealthRow } from "../../shared";
import { useServerHealthMap } from "../hooks";
import { serverStatus, ServerStatusDot } from "./server-status-badge";

const serversIcon = symbol("dns");
const addIcon = symbol("add");

/**
 * The Deploy sidebar's Servers section: every registered server with its
 * reachability dot, the open one marked; "+" opens the add-server page.
 *
 * Contributed by `health`, not `servers`: the dot is this plugin's verdict, and
 * `servers` cannot import `health` (health imports servers — the reverse edge
 * would close a cycle).
 */
export function ServersSidebarSection(): ReactElement {
  const list = useLive(servers);
  // The health read names exactly the listed servers; until the list lands it
  // asks for none, and the combined gate below stays loading meanwhile.
  const ids = useMemo(
    () =>
      foldResource(list, {
        loading: (): string[] => [],
        error: (): string[] => [],
        ready: (rows) => rows.map((s) => s.id),
      }),
    [list],
  );
  const loaded = useCombinedResources({
    servers: list,
    health: useServerHealthMap(ids),
  });
  return (
    <SidebarPaneSection
      icon={serversIcon}
      title="Servers"
      labelExtra={AddServer}
    >
      {matchResource(loaded, {
        loading: () => <Loading variant="rows" />,
        ready: ({ servers: rows, health }) => (
          <ServerRows rows={rows} health={health} />
        ),
      })}
    </SidebarPaneSection>
  );
}

function AddServer(): ReactElement {
  const openPane = useOpenPane();
  const link = openPane.link(
    serverDetailPane,
    { serverId: NEW_SERVER_ID },
    { mode: "root" },
  );
  return (
    <IconButton
      icon={addIcon}
      label="Add server"
      glyph="small"
      {...link}
      onClick={(e) => {
        // The "+" sits inside the section's fold trigger: adding a server must
        // not also fold the list.
        e.stopPropagation();
        link.onClick?.(e);
      }}
    />
  );
}

function ServerRows({
  rows,
  health,
}: {
  rows: readonly ServerListRow[];
  health: ReadonlyMap<string, ServerHealthRow>;
}): ReactNode {
  const openPane = useOpenPane();
  // The selection is the ROUTE (the add form's `new` matches no row).
  const openId = serverDetailPane.useRouteEntry()?.params.serverId;
  if (rows.length === 0) {
    return (
      <Text as="p" variant="caption" tone="muted">
        No servers yet.
      </Text>
    );
  }
  return (
    <SidebarMenu>
      {rows.map((s) => (
        <SidebarMenuItem key={s.id}>
          <SidebarMenuButton
            isActive={s.id === openId}
            {...openPane.link(
              serverDetailPane,
              { serverId: s.id },
              { mode: "root" },
            )}
          >
            <ServerStatusDot status={serverStatus(health.get(s.id))} />
            <span>{s.name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
