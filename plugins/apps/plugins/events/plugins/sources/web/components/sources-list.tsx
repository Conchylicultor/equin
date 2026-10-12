import { Icon } from "@plugins/ui/plugins/icons/web";
import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  type CreateOption,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useEventSources } from "@plugins/apps/plugins/events/plugins/events-core/web";
import {
  extractionStatus,
  sourceState,
  type EventSource,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import { eventSourceDetailPane } from "../panes";
import { EventSourceActions } from "../slots";
import { useEventSourceTypes } from "../internal/source-types";
import {
  CADENCE_OPTIONS,
  EXTRACTION_STATUS_OPTIONS,
  SOURCE_STATE_OPTIONS,
  SOURCE_STATUS_OPTIONS,
} from "../internal/format";
import { openAddSourceDialog } from "./add-source-dialog";

/**
 * The configured sources, config-backed like every DataView: the view instances
 * live only in `config/apps/events/sources/events.sources.jsonc`.
 */
const SOURCES_VIEW = defineDataView("events.sources");

export function SourcesList(): ReactNode {
  const result = useEventSources();
  const openPane = useOpenPane();
  const types = useEventSourceTypes();
  const selectedId = eventSourceDetailPane.useRouteEntry()?.params.sourceId;

  // Every dimension is a typed field, so search / filter / sort / group-by come
  // free — there are no bespoke filter chips on this toolbar, by design.
  //
  // `type`'s options are built from the live registry, never a literal list: a
  // third source type must widen this filter with zero edits here.
  const fields = useMemo<FieldDef<EventSource>[]>(() => {
    // Resolved ONCE per registry change, not per row: the cell below is a plain
    // function the list calls while rendering, so it can hold no hook of its
    // own — and the registry it would have asked is already right here.
    const typeLabel = new Map(types.map((t) => [t.id, t.label]));
    return [
      {
        id: "name",
        label: "Name",
        type: "text",
        primary: true,
        value: (s) => s.name,
      },
      {
        id: "type",
        label: "Type",
        type: "enum",
        options: types.map((t) => ({ value: t.id, label: t.label })),
        value: (s) => s.type,
        // The one per-field cell on this list, and it exists for exactly one
        // state the option list cannot hold: a source whose TYPE PLUGIN is not
        // installed has no option to look up, so the generic chip would print
        // the bare id (`shotgun`) and the row would read like every other one.
        // Naming it out loud is the same "not installed" state the Settings
        // section shows — and it still names no type: the id comes from the row.
        cell: (s) => (
          <Badge
            variant="muted"
            title={
              typeLabel.has(s.type)
                ? undefined
                : "This source's type plugin is not installed, so it cannot be refreshed or configured."
            }
          >
            {typeLabel.get(s.type) ?? `${s.type} (not installed)`}
          </Badge>
        ),
      },
      {
        id: "refresh",
        label: "Cadence",
        type: "enum",
        options: CADENCE_OPTIONS,
        value: (s) => s.refresh,
      },
      // The ONE thing the row says about a source, derived in `events-core`
      // beside `extractionStatus`: `Disabled` > `Running` > the last
      // extraction's verdict. Each arm's word, tint and tooltip travel on the
      // option, so this field is a projection and nothing more.
      {
        id: "state",
        label: "State",
        type: "enum",
        options: SOURCE_STATE_OPTIONS,
        value: (s) => sourceState(s),
      },
      // The three fields `state` is derived FROM stay declared and stay
      // unprinted (`visible: false`): each is still a real sort / filter /
      // group-by dimension — `Needs attention` filters on `extraction` AND
      // `enabled` — and the user can switch any of them on from Properties.
      // Printing them alongside `state` would be the same fact three times.
      {
        id: "status",
        label: "Status",
        type: "enum",
        options: SOURCE_STATUS_OPTIONS,
        value: (s) => s.status,
        visible: false,
      },
      // A DERIVED dimension: there is no `extraction` column — it is computed
      // by `extractionStatus` from the two the run ledger writes. Fine exactly
      // here — this DataView is client-side over the whole live sources set, so
      // filter / sort / group-by run over the rows already in hand and need no
      // server binding. (A server-delegated view, like `event-list`, could not
      // do this: its filters compile to SQL against real columns.)
      //
      // It is the dimension that answers the question `status` cannot —
      // "which of my sources are silently returning nothing" — so it is what
      // the `Needs attention` view should be filtering on.
      {
        id: "extraction",
        label: "Extraction",
        type: "enum",
        options: EXTRACTION_STATUS_OPTIONS,
        value: (s) => extractionStatus(s),
        visible: false,
      },
      {
        id: "enabled",
        label: "Enabled",
        type: "bool",
        value: (s) => s.enabled,
        visible: false,
      },
      {
        id: "lastRunAt",
        label: "Last run",
        type: "date",
        value: (s) => s.lastRunAt,
        align: "end",
      },
    ];
  }, [types]);

  // The `+` menu IS the registry: one creator per installed source type, in
  // contributed order. Nothing here names a type, so adding one is zero edits.
  const creators = useMemo<CreateOption[]>(
    () =>
      types.map((t) => {
        const icon = t.icon;
        return {
          id: t.id,
          label: t.label,
          icon: icon ? <Icon icon={icon} className="icon-auto" /> : undefined,
          onSelect: () =>
            openAddSourceDialog(t, (sourceId) =>
              openPane(eventSourceDetailPane, { sourceId }, { mode: "push" }),
            ),
        };
      }),
    [types, openPane],
  );

  const renderList = (sources: EventSource[]): ReactElement => (
    <DataView<EventSource>
      storageKey={SOURCES_VIEW}
      rows={sources}
      fields={fields}
      rowKey={(s) => s.id}
      views={["list", "table"]}
      readiness={result}
      creators={creators}
      itemActions={EventSourceActions}
      selectedRowId={selectedId}
      rowActivation={(s) =>
        openPane.to(eventSourceDetailPane, { sourceId: s.id }, { mode: "push" })
      }
      // A switched-off source reads "off" from the whole line, before a single
      // word is read — which is what lets the row spend its one chip on the
      // state instead of on saying "off" twice. The list honours it; the table
      // deliberately does not (its per-row seam is already spoken for).
      rowTone={(s) => (s.enabled ? "default" : "muted")}
      emptyState={
        types.length === 0
          ? "No source types are installed, so there is nothing to add yet."
          : "No sources yet — use + to add one."
      }
    />
  );

  // One render path for every state: the DataView paints its own skeleton while
  // loading and the failure (with Retry) when the subscription broke
  // (`readiness`), and the toolbar (search / +) stays put — so neither a loading
  // nor a failed list can masquerade as a confirmed-empty one.
  return matchResource(result, {
    loading: () => renderList([]),
    error: () => renderList([]),
    ready: (sources) => renderList(sources),
  });
}
