import { defineConfig } from "@plugins/config_v2/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// Read off disk by the CLI processes that stamp a slot unserved (a build's
// `serveSlot`, `reclaimSlots`) — the stamp carries the threshold to the
// release paths, which read no config. The `name` is a persisted literal.
export const mainSlotsConfig = defineConfig({
  name: "main-slots",
  fields: {
    drainReportAfterSec: intField({
      default: 10,
      min: 1,
      label: "Report a slow drain after (s)",
      description:
        "A process still holding one of main's slots this many seconds after its app switched to a newer slot is reported (main-slot-drain-slow), naming the job — what to make faster, or stop outliving its app.",
    }),
  },
});
