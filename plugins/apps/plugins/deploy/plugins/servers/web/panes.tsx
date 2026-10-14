import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  Pane,
  PaneChrome,
  useOpenPane,
  resolveFrom,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { serversRoute, serverDetailRoute } from "../core";
import { servers, serverSshKey, type Server } from "../shared";
import { ServersList } from "./components/servers-list";
import { ServerCreateForm } from "./components/server-create-form";
import { ServerDetail } from "./slots";

/**
 * Sentinel `:serverId` for the create state of the unified server pane. Real
 * ids are `srv-…`, so this can never collide with an existing server.
 */
export const NEW_SERVER_ID = "new";

export const serversRootPane = Pane.define({
  title: "Servers",
  route: serversRoute,
  app: deployApp,
  // The Deploy app's index/landing pane — what its bare root (/deploy)
  // resolves to. Its route owns no segment, for exactly that reason.
  appIndex: true,
  component: ServersRoot,
  width: 320,
});

function useResolveServer({ serverId }: { serverId: string }): ResolveResult {
  const result = useLive(servers);
  // The create form names no server, so it needs no list to exist.
  if (serverId === NEW_SERVER_ID) return { status: "found" };
  return resolveFrom(result, (list) => list.some((s) => s.id === serverId));
}

/** "Add Server" for the create state, else the server's name once it loads. */
function useServerTitle({
  serverId,
}: {
  serverId: string;
}): string | undefined {
  const result = useLive(servers);
  if (serverId === NEW_SERVER_ID) return "Add Server";
  switch (result.status) {
    case "loading":
    case "error":
      return undefined;
    case "ready":
      break;
  }
  return result.data.find((s) => s.id === serverId)?.name;
}

// Single unified server pane: `server/new` is the add form, `server/:id` is the
// same page in edit mode. One route serves both, so adding and editing a server
// are the same surface.
export const serverDetailPane = Pane.define({
  route: serverDetailRoute,
  app: deployApp,
  component: ServerDetailBody,
  useResolve: useResolveServer,
  title: { useText: useServerTitle, fallback: "Server" },
  width: 420,
});

function ServersRoot() {
  return (
    <PaneChrome pane={serversRootPane}>
      <ServersList />
    </PaneChrome>
  );
}

function ServerDetailBody() {
  const { serverId } = serverDetailPane.useParams();
  const openPane = useOpenPane();

  if (serverId === NEW_SERVER_ID) {
    return (
      <PaneChrome pane={serverDetailPane}>
        <ServerCreateForm
          // `swap` replaces the create state with the real server in place — no
          // new column, so the pane transitions add → edit seamlessly.
          onCreated={(id) =>
            openPane(serverDetailPane, { serverId: id }, { mode: "swap" })
          }
        />
      </PaneChrome>
    );
  }
  return <ExistingServerBody serverId={serverId} />;
}

/**
 * A registered server's pane: the registry row beside the key this app holds
 * for it (`serverSshKey`, read per server — the list rows carry no key), joined
 * into the `Server` every section is handed. Loading until BOTH land: a
 * section never sees a server without knowing whether it has a key.
 */
function ExistingServerBody({ serverId }: { serverId: string }) {
  const combined = useCombinedResources({
    servers: useLive(servers),
    sshKey: useLive(serverSshKey, { serverId }),
  });

  switch (combined.status) {
    case "loading":
      return (
        <PaneChrome pane={serverDetailPane}>
          <Loading variant="rows" />
        </PaneChrome>
      );
    case "error":
      return (
        <PaneChrome pane={serverDetailPane}>
          <ResourceErrorInline
            variant="block"
            subject="the server"
            error={combined.error}
            refetch={combined.refetch}
          />
        </PaneChrome>
      );
    case "ready":
      break;
  }

  const row = combined.data.servers.find((s) => s.id === serverId) ?? null;

  if (!row) {
    return (
      <PaneChrome pane={serverDetailPane}>
        <Text as="div" variant="body" className="text-muted-foreground p-lg">
          Server not found.
        </Text>
      </PaneChrome>
    );
  }

  const server: Server = { ...row, sshKey: combined.data.sshKey };
  // The whole pane body is the one section slot: identity, SSH setup and
  // deployments are peer contributions, and the host owns all of the chrome.
  return (
    <PaneChrome pane={serverDetailPane}>
      <ServerDetail.Host server={server} />
    </PaneChrome>
  );
}
