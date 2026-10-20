import { useState, type ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  scanArea,
  useStorageUsage,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { formatBytes } from "../internal/format";
import { storageRows, type StorageRow } from "../internal/storage-rows";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const STORAGE_OWNERS_VIEW = defineDataView("web-storage.owners");

const bytesCell = (n: number | null) => (n === null ? "—" : formatBytes(n));

const FIELDS: FieldDef<StorageRow>[] = [
  {
    id: "label",
    label: "Owner",
    type: "text",
    primary: true,
    value: (r) => r.label,
    sortable: true,
  },
  {
    id: "area",
    label: "Area",
    type: "enum",
    value: (r) => r.area,
    options: [
      { value: "local", label: "localStorage" },
      { value: "session", label: "sessionStorage" },
    ],
    filterable: true,
    groupable: true,
    // The list groups by it; a column would repeat the group header.
    visible: false,
  },
  {
    id: "bytes",
    label: "Used",
    type: "number",
    value: (r) => r.bytes,
    cell: (r) => bytesCell(r.bytes),
    sortable: true,
    align: "end",
  },
  {
    id: "cap",
    label: "Cap",
    type: "number",
    value: (r) => r.cap,
    cell: (r) => bytesCell(r.cap),
    sortable: true,
    align: "end",
  },
  {
    id: "keys",
    label: "Keys",
    type: "number",
    value: (r) => r.keys,
    sortable: true,
    align: "end",
    visible: false,
  },
  {
    id: "policy",
    label: "When full",
    type: "enum",
    value: (r) => r.policy ?? "",
    options: [
      { value: "evict-oldest", label: "Evict oldest" },
      { value: "refuse", label: "Refuse" },
    ],
    filterable: true,
    visible: false,
  },
  {
    id: "evicted",
    label: "Evicted",
    type: "number",
    value: (r) => r.evicted,
    sortable: true,
    align: "end",
    visible: false,
  },
  {
    id: "refused",
    label: "Refused",
    type: "number",
    value: (r) => r.refused,
    sortable: true,
    align: "end",
  },
  {
    id: "note",
    label: "Note",
    type: "text",
    value: (r) => r.note ?? "",
    visible: false,
  },
];

/**
 * The Browser storage row's detail: every owner's footprint against its cap,
 * plus the keys no owner holds. The owners' numbers are live; the area scan
 * that fills in the rest runs once, when the detail opens.
 */
export function StorageDetail(): ReactElement {
  const usage = useStorageUsage();
  const [scans] = useState(() => [scanArea("local"), scanArea("session")]);
  return (
    <DataView<StorageRow>
      rows={storageRows(usage, scans)}
      fields={FIELDS}
      rowKey={(r) => r.id}
      views={["list", "table"]}
      storageKey={STORAGE_OWNERS_VIEW}
      searchAccessor={(r) => `${r.label} ${r.id} ${r.note ?? ""}`}
      emptyState={<>Nothing stored.</>}
    />
  );
}
