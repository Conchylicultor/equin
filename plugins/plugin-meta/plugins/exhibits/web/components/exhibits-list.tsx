import { useMemo, type ReactElement } from "react";
import {
  exhibitGroupOf,
  type Exhibit,
  type ExhibitRuntime,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { useExhibits } from "../use-exhibits";
import {
  homeLabelOf,
  isMeasured,
  RUNTIME_BADGE,
  widthsOf,
} from "./exhibit-meta";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const EXHIBITS_CATALOG = defineDataView("plugin-meta.exhibits.catalog");

const RUNTIMES: readonly ExhibitRuntime[] = [
  "isolated",
  "isolated-region",
  "app",
];

interface ExhibitRow {
  /** Id plus catalog position: the catalog is not de-duplicated, so a clashing
   * id shows twice rather than collapsing. */
  key: string;
  exhibit: Exhibit;
}

const NO_ROWS: ExhibitRow[] = [];

const EXHIBITS_PLACE = { runtime: "afterTitle" } as const;

/**
 * Debug → Exhibits: the catalog as a list — one row per exhibit, searchable
 * and grouped by id prefix. Nothing renders here; a row opens the exhibit in
 * the viewer pane beside it.
 */
export function ExhibitsList({
  selectedId,
  linkTo,
}: {
  selectedId: string | undefined;
  /** Where a row goes: a link, so ⌘/middle-click opens it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}): ReactElement {
  const catalog = useExhibits();
  const rows = useMemo(
    () =>
      catalog.kind === "loading"
        ? NO_ROWS
        : catalog.exhibits.map((exhibit, i) => ({
            key: `${exhibit.id}#${String(i)}`,
            exhibit,
          })),
    [catalog],
  );

  const fields = useMemo<FieldDef<ExhibitRow>[]>(
    () => [
      {
        id: "label",
        label: "Exhibit",
        type: "text",
        primary: true,
        value: (r) => r.exhibit.label,
        width: "minmax(0,1fr)",
      },
      {
        id: "id",
        label: "Id",
        type: "identifier",
        value: (r) => r.exhibit.id,
      },
      {
        id: "group",
        label: "Group",
        type: "text",
        value: (r) => exhibitGroupOf(r.exhibit.id),
        filterable: true,
        sortable: true,
        width: "8rem",
      },
      {
        id: "runtime",
        label: "Runtime",
        type: "enum",
        value: (r) => r.exhibit.runtime,
        options: RUNTIMES.map((v) => ({
          value: v,
          label: RUNTIME_BADGE[v].label,
          variant: RUNTIME_BADGE[v].variant,
        })),
        filterable: true,
        width: "6rem",
      },
      {
        id: "home",
        label: "Home",
        type: "text",
        value: (r) => homeLabelOf(r.exhibit),
        filterable: true,
        width: "8rem",
      },
      {
        id: "geometry",
        label: "Geometry",
        type: "bool",
        value: (r) => isMeasured(r.exhibit),
        filterable: true,
        width: "5rem",
      },
      {
        id: "widths",
        label: "Widths",
        type: "text",
        value: (r) => widthsOf(r.exhibit).join(" · "),
        width: "9rem",
      },
      {
        id: "description",
        label: "Description",
        type: "multiline-text",
        value: (r) => r.exhibit.description ?? "",
      },
    ],
    [],
  );

  return (
    <DataView<ExhibitRow>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.key}
      storageKey={EXHIBITS_CATALOG}
      views={["table", "list"]}
      defaultView="table"
      // The runtime is a mark beside the exhibit's name, as on its viewer.
      place={EXHIBITS_PLACE}
      readiness={
        catalog.kind === "loading" ? { status: "loading" } : { status: "ready" }
      }
      selectedRowId={rows.find((r) => r.exhibit.id === selectedId)?.key}
      rowActivation={(r) => linkTo(r.exhibit.id)}
      emptyState="No exhibits contributed yet."
    />
  );
}
