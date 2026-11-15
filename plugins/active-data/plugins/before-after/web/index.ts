import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import { baIdKind } from "@plugins/conversations/plugins/before-after/core";
import { BEFORE_AFTER_ICON } from "@plugins/conversations/plugins/before-after/web";
import { BEFORE_AFTER_CHIP_SURFACES } from "../core";
import {
  useBeforeAfterPane,
  useBeforeAfterReferent,
} from "./internal/presenter";

export default {
  description:
    "Renders raw `ba-<id>` strings inline as clickable chips (the generic id chip: the pair's title) that open the pair in the Before / after pane beside the text, and presents the before / after id kind to the id registry. Models emit the bare id an agent was handed by register_before_after.",
  contributions: [
    ...idChip({
      presenter: {
        kind: baIdKind,
        icon: BEFORE_AFTER_ICON,
        useReferent: useBeforeAfterReferent,
        usePane: useBeforeAfterPane,
      },
      surfaces: BEFORE_AFTER_CHIP_SURFACES,
    }),
  ],
} satisfies PluginDefinition;
