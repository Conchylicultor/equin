import { Icon } from "@plugins/ui/plugins/icons/web";
import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  type CreateOption,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useEventSources } from "@plugins/apps/plugins/events/plugins/events-core/web";
import {
  eventSources,
  extractionStatus,
  sourceState,
  type EventSource,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import { eventSourceDetailPane } from "../panes";
import { EventSourceActions } from "../slots";
import { useEventSourceTypes } from "../internal/source-types";
import {
  EXTRACTION_STATUS_OPTIONS,
  SOURCE_STATE_OPTIONS,
} from "../internal/format";
import { openAddSourceDialog } from "./add-source-dialog";

/**
 * The configured sources, config-backed like every DataView: the view instances
 * live only in `config/apps/events/sources/events.sources.jsonc`.
 */
const SOURCES_VIEW = defineDataView("events.sources");

// The two fields the list computes itself, both derived from the run
// bookkeeping the source row carries — every other field is derived from the
// `eventSources` collection (its entity's labels and options, the type's
// options read from the live registry of source types, see
// `internal/presentation.tsx`). They filter, sort and group in memory, which
// is exactly right here: this DataView is client-side over the whole live
// sources set (a server-delegated view, like `event-list`, could not do this —
// its filters compile to SQL against real columns).
const SOURCE_EXTRA_FIELDS: FieldDef<EventSource>[] = [
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
  // A DERIVED dimension: there is no `extraction` column — it is computed
  // by `extractionStatus` from the two the run ledger writes. It is the
  // dimension that answers the question `status` cannot — "which of my
  // sources are silently returning nothing" — so it is what the `Needs
  // attention` view filters on. `state` is derived FROM it (and `enabled`,
  // `status`), so it stays declared and unprinted (`visible: false`): printing
  // both would be the same fact twice, and it is still a real sort / filter /
  // group-by dimension the user can switch on from Properties.
  {
    id: "extraction",
    label: "Extraction",
    type: "enum",
    options: EXTRACTION_STATUS_OPTIONS,
    value: (s) => extractionStatus(s),
    visible: false,
  },
];

export function SourcesList(): ReactNode {
  const result = useEventSources();
  const openPane = useOpenPane();
  const types = useEventSourceTypes();
  const selectedId = eventSourceDetailPane.useRouteEntry()?.params.sourceId;

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
      collection={eventSources}
      extraFields={SOURCE_EXTRA_FIELDS}
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
