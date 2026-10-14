import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { servers, type ServerListRow } from "../../shared";
import { serverDetailPane, NEW_SERVER_ID } from "../panes";
import { ServerItemActions } from "./server-item-actions";

const SERVERS_VIEW = defineDataView("deploy.servers");

// The registry's address, from two carried columns — the one field the list
// computes itself. Every other field is derived from the `servers` collection:
// the name (the entity's), and `status` — the reachability verdict `health`
// exposes on the entity, which this list never names.
const SERVER_EXTRA_FIELDS: FieldDef<ServerListRow>[] = [
  {
    id: "address",
    label: "Address",
    type: "text",
    value: (s) => `${s.host}:${s.port}`,
  },
];

export function ServersList() {
  const result = useLive(servers);
  const openPane = useOpenPane();
  const selectedId = serverDetailPane.useRouteEntry()?.params.serverId;

  // One render path for every state: DataView renders its skeleton while
  // loading and the failure (with Retry) when the read failed (`readiness`), and
  // the chrome (search / + Add) stays stable — the "No servers registered" empty
  // state requires confirmed-empty.
  const renderList = (rows: ServerListRow[]) => (
    <DataView<ServerListRow>
      rows={rows}
      collection={servers}
      extraFields={SERVER_EXTRA_FIELDS}
      rowKey={(s) => s.id}
      views={["list"]}
      defaultView="list"
      storageKey={SERVERS_VIEW}
      readiness={result}
      itemActions={ServerItemActions}
      selectedRowId={selectedId}
      rowActivation={(s) =>
        openPane.to(serverDetailPane, { serverId: s.id }, { mode: "push" })
      }
      actions={
        <Button
          variant="default"
          {...openPane.link(
            serverDetailPane,
            { serverId: NEW_SERVER_ID },
            { mode: "push" },
          )}
        >
          + Add
        </Button>
      }
      emptyState="No servers registered. Add one to get started."
    />
  );

  return matchResource(result, {
    loading: () => renderList([]),
    error: () => renderList([]),
    ready: (rows) => renderList(rows),
  });
}
