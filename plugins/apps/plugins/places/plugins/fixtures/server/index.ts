import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { writePlacesFixture } from "./internal/write-places";

export default {
  description:
    "Places fixtures, server half: writePlacesFixture writes a PlacesFixture through the app's real write paths — the starter tag tree a fresh install seeds, the fixture's tags through the tag tree's own endpoints (create path, then colour and icon), each place through insertPlace with its icon given — so no Google call and no model is needed. Derives nothing else.",
} satisfies ServerPluginDefinition;
