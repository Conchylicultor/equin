import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";
import {
  externalUrl,
  type ListedEvent,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import { EVENT_LIST_SEARCHABLE, eventsList, type EventListRow } from "../core";
import { useOpenEvent } from "./internal/use-open-event";
import { EventRow } from "./components/event-row";

/**
 * The Events surface id. Config-backed like every DataView: the view instances
 * (`Upcoming`, `All`, `By category`, …) live ONLY in
 * `config/apps/events/event-list/events.list.jsonc` — there is no
 * code-synthesized default, by design. It IS `eventsList`'s column scope
 * (asserted at mount): the surface whose custom columns sort and filter it.
 */
const EVENTS_LIST_VIEW = defineDataView("events.list");

/**
 * The live source: the `events.list` collection, kept fresh by the routed change
 * feed (an event write, a source's type / config / enabled flip) with no tick
 * and no refetch. The search box matches what an event is and where it is.
 */
const eventsListSource = liveDataSource(eventsList, {
  searchable: EVENT_LIST_SEARCHABLE,
});

/**
 * The fields are `eventsList`'s, derived (the events entity's, presented by
 * `./internal/presentation.tsx` and, for `sourceId`, by the sources plugin).
 * The source dimension is a grouping dimension, not searchable text: an id
 * typed into the search box must not match every event from that source.
 */
const EVENT_LIST_OVERRIDES = fieldOverrides(eventsList, {
  sourceId: { filterable: false },
});

export const eventListPane = Pane.define({
  title: "Events",
  route: defineRoute({ id: "event-list", segment: "list" }),
  app: eventsApp,
  component: EventListPaneView,
  width: 560,
});

function EventListPaneView(): ReactElement {
  // Activating a row means "show me this event": its own page, else the page it
  // was extracted from. Passed at the host level, so the list rows, the table
  // rows and the gallery cards all open the same thing.
  const openEvent = useOpenEvent();

  return (
    <PaneChrome pane={eventListPane}>
      <DataView<EventListRow>
        storageKey={EVENTS_LIST_VIEW}
        overrides={EVENT_LIST_OVERRIDES}
        onRowActivate={openEvent}
        views={["list", "table", "gallery"]}
        emptyState={
          <Placeholder>
            No events — add a source from Sources to start collecting them.
          </Placeholder>
        }
        // The poster as the card's cover (and the list's thumbnail).
        // `imageUrl` is deliberately NOT a listed field (it is a display
        // input, not a sort/filter dimension — see core/internal/fields.ts),
        // so the cover comes from the accessor. No usable poster → `null` → a
        // blank tinted frame the size of every other card's, never a broken
        // image.
        cover={(e) => {
          const src = externalUrl(e.imageUrl);
          return src === null ? null : { kind: "image", src };
        }}
        viewOptions={{
          list: {
            size: "md",
            renderRow: (e: ListedEvent) => <EventRow event={e} />,
          },
        }}
        source={eventsListSource}
      />
    </PaneChrome>
  );
}
