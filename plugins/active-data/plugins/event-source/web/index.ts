import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { eventSourceIdKind } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { EVENT_SOURCE_CHIP_SURFACES } from "../core";
import {
  useEventSourceReferent,
  useEventSourceTarget,
} from "./internal/presenter";

export default {
  description:
    "Renders a bare `evs-<id>` in a transcript as the generic id chip (the source's name) that opens the event source's detail pane, and presents the event-source id kind to the id registry.",
  contributions: [
    ...idChip({
      presenter: {
        kind: eventSourceIdKind,
        icon: symbol("event"),
        useReferent: useEventSourceReferent,
        useTarget: useEventSourceTarget,
      },
      surfaces: EVENT_SOURCE_CHIP_SURFACES,
    }),
  ],
} satisfies PluginDefinition;
