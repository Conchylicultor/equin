import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

// The one ops log of the derived-view layer: the boot rebuild and the
// pre-migration drop both write here.
export const derivedViewsLog = defineLogSink({
  id: "derived-views",
  description:
    "Derived-views ops log: the live view layer dropped before pending migrations, and plain DB view drops/creates in dependency order on boot.",
});
