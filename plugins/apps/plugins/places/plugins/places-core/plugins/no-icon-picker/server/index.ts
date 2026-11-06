import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { PlaceIconPicker } from "@plugins/apps/plugins/places/plugins/places-core/server";

export default {
  description:
    "The place icons of a host without a model: provides the PlaceIconPicker host service as nothing to pick with — there is no Claude CLI to ask, so a new place keeps drawing its main tag's icon, the same pin the desktop draws before its pick lands (the browser composition). Never booted by the desktop.",
  contributions: [
    PlaceIconPicker.provide({
      pick: () =>
        Promise.resolve({
          kind: "no-picker",
          reason: "no model on this host to pick an icon with",
        }),
    }),
  ],
} satisfies ServerPluginDefinition;
