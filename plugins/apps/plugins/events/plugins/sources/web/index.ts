import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Events } from "@plugins/apps/plugins/events/plugins/shell/web";
import { eventSourcesPane, eventSourceDetailPane } from "./panes";
import { EventSourceActions, EventSourceDetail } from "./slots";
import { SourceDeleteAction } from "./components/source-delete-action";
import { SourceOpenAction } from "./components/source-open-action";
import { SourceToggleAction } from "./components/source-toggle-action";
import { sourcePresentation } from "./internal/presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export {
  eventSourcesPane,
  eventSourceDetailPane,
  eventSourceDetailRoute,
} from "./panes";
export { EventSourceDetail, EventSourceActions } from "./slots";
export { SourceConfigForm } from "./components/source-config-form";
export type { SourceConfigFormProps } from "./components/source-config-form";
export { useEventSource } from "./internal/use-source";
export type { SourceLookup } from "./internal/use-source";
export {
  useEventSourceType,
  useEventSourceTypes,
} from "./internal/source-types";
export type {
  EventSourceTypeContribution,
  SourceTypeLookup,
} from "./internal/source-types";
export {
  initialConfigValues,
  readConfigValues,
} from "./internal/config-values";
export type { ConfigValues } from "./internal/config-values";
export {
  CADENCE_LABEL,
  SOURCE_STATUS_LABEL,
  SOURCE_STATUS_VARIANT,
  EXTRACTION_STATUS_LABEL,
  EXTRACTION_STATUS_OPTIONS,
  EXTRACTION_STATUS_VARIANT,
  EXTRACTION_STATUS_HINT,
  SOURCE_STATE_OPTIONS,
  RUN_OUTCOME_LABEL,
  RUN_OUTCOME_OPTIONS,
  RUN_OUTCOME_VARIANT,
  describeRun,
  formatDuration,
} from "./internal/format";

export default {
  description:
    "The Events app's Sources surface: the sidebar entry, the sources DataView with a registry-driven `+` menu, and the per-source side-pane whose sections are contributions. Renders every source type's configuration form generically from its `configFields`, so a source type ships no form code.",
  contributions: [
    Pane.Register({ pane: eventSourcesPane }),
    Pane.Register({ pane: eventSourceDetailPane }),
    sourcePresentation,
    Events.Sidebar({
      id: "sources",
      title: "Sources",
      icon: symbol("folder-code"),
      opens: { pane: eventSourcesPane, params: {} },
    }),
    // Ordered by how much each one changes: `open` only looks (and renders
    // nothing at all for a source that stands for no page), `enabled` is
    // reversible by the same control, `delete` is not. A reversible action must
    // not sit where the user's muscle memory has put the destructive one (the
    // rightmost button).
    EventSourceActions({ id: "open", component: SourceOpenAction }),
    EventSourceActions({ id: "enabled", component: SourceToggleAction }),
    EventSourceActions({ id: "delete", component: SourceDeleteAction }),
  ],
  slots: {
    ...EventSourceDetail,
    itemActions: EventSourceActions,
    "event-sources": eventSourcesPane,
    "event-source-detail": eventSourceDetailPane,
  },
} satisfies PluginDefinition;
