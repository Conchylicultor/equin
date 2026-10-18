import { entityRef } from "@plugins/infra/plugins/entities/core";
import {
  eventFields,
  eventSourceFields,
  eventSourceRunEventFields,
  eventSourceRunFields,
} from "./fields";

// The Events entities a list reads, by reference — what a browser-safe
// declaration names them with (a collection's `from`, a presentation's
// `owner`), carrying each entity's field record. Each name is its table's:
// `server/internal/tables.ts` builds the table from the ref
// (`defineEntity(ref, meta)`).
export const eventsEntityRef = entityRef("events", eventFields);
export const eventSourcesEntityRef = entityRef(
  "event_sources",
  eventSourceFields,
);
export const eventSourceRunsEntityRef = entityRef(
  "event_source_runs",
  eventSourceRunFields,
);
export const eventSourceRunEventsEntityRef = entityRef(
  "event_source_run_events",
  eventSourceRunEventFields,
);
