import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { TableDetail } from "./slots";

export const tableDetailPane = Pane.define({
  route: defineRoute({ id: "table-detail", segment: "t/:pluginId/:tableName" }),
  app: studioApp,
  component: TableDetailBody,
  useResolve: false,
  title: { fallback: (params) => params.tableName },
});

function TableDetailBody() {
  const { tableName, pluginId } = tableDetailPane.useParams();
  return (
    <PaneChrome pane={tableDetailPane}>
      <TableDetail.Host tableName={tableName} pluginId={pluginId} />
    </PaneChrome>
  );
}
