import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { idChip } from "@plugins/active-data/plugins/id-chip/web";
import {
  protoIdKind,
  VARIANT_QUERY_PATTERN,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PROTOTYPE_CHIP_SURFACES, openPrototypeHint } from "../core";
import {
  prototypeVariantLabel,
  usePrototypePane,
  usePrototypeReferent,
  usePrototypeVariantPane,
} from "./internal/presenter";

export default {
  description:
    "Renders raw `proto-<id>` strings inline as clickable chips (the generic id chip: the mock's title) that open the mock in the prototype-detail pane — on one variant when the id is followed by its picks (`proto-…?pane=floating&accent=#10b981`, frame A showing it through the pane's ;variant= key, the user's shared picks untouched), and presents the prototype id kind to the id registry. Models emit the bare id, no tag wrapping needed. The first chip the user meets carries a one-time “Click to open the prototype” tip.",
  contributions: [
    ...idChip({
      presenter: {
        kind: protoIdKind,
        icon: symbol("dashboard-customize"),
        useReferent: usePrototypeReferent,
        usePane: usePrototypePane,
      },
      surfaces: PROTOTYPE_CHIP_SURFACES,
      // `proto-…?pane=floating`: a chip opening the mock on one variant.
      qualifier: {
        pattern: VARIANT_QUERY_PATTERN,
        usePane: usePrototypeVariantPane,
        label: prototypeVariantLabel,
      },
      hint: openPrototypeHint,
    }),
  ],
} satisfies PluginDefinition;
