import type { ReactNode } from "react";
import {
  dataFileRoots,
  type BrowsableRoot,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { filesDataAtPane } from "../panes";

const APP_DATA_ROOTS_VIEW = defineDataView("file-explorer.app-data.roots");

const rootIcon = symbol("database");

const NO_ROOTS: readonly BrowsableRoot[] = [];

const fields: FieldDef<BrowsableRoot>[] = [
  {
    id: "icon",
    label: "Icon",
    type: "icon",
    header: false,
    filterable: false,
    sortable: false,
    groupable: false,
    value: (r) => r.id,
    cell: () => <Icon icon={rootIcon} className="size-4" />,
  },
  { id: "label", label: "Name", primary: true, value: (r) => r.label },
  { id: "dir", label: "Data folder", value: (r) => r.dir },
];

/**
 * The App data landing: every browsable file root of this host (an app's own
 * files — the computer's disk on the desktop, memory in the in-browser demo),
 * each opening its root folder.
 */
export function AppDataRoots(): ReactNode {
  const roots = useLive(dataFileRoots);
  const openPane = useOpenPane();
  return (
    <DataView<BrowsableRoot>
      storageKey={APP_DATA_ROOTS_VIEW}
      rows={foldResource(roots, {
        // The read's own state reaches the view through `readiness`.
        loading: () => NO_ROOTS,
        error: () => NO_ROOTS,
        ready: (data) => data,
      })}
      readiness={roots}
      fields={fields}
      rowKey={(r) => r.id}
      views={["list"]}
      emptyState={<Placeholder>No app shares its files here</Placeholder>}
      rowActivation={(r) =>
        openPane.to(filesDataAtPane, { root: r.id }, { mode: "root" })
      }
    />
  );
}
