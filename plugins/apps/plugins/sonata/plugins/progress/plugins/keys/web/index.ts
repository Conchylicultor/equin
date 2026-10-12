import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataProgress } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import { KeyFlags } from "./components/key-flags";
import {
  describeKey,
  keyChangeBeats,
  keyLabels,
} from "./components/key-labels";

export default {
  description:
    "Sonata progress keys: a thin key-coloured line on the progression rail at each key change, the key names in the label lane under it (starting key muted), and the hover preview's key line (key in force, or 'Key change → …' snapped onto a change). Keys come from the starting key + 'key' annotations.",
  contributions: [
    SonataProgress.Marker({ id: "keys", component: KeyFlags }),
    SonataProgress.Label({ id: "keys", order: 1, labels: keyLabels }),
    SonataProgress.Describe({
      id: "keys",
      order: 1,
      line: "body",
      describe: describeKey,
      snapBeats: keyChangeBeats,
    }),
  ],
} satisfies PluginDefinition;
