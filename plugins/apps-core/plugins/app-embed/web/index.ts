import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AppEmbed, type AppEmbedLeave } from "./components/app-embed";

export default {
  description:
    "<AppEmbed app route onLeave? />: one app surface rendered in-process — the SurfaceCore a tab mounts — with its own non-live pane store (seeded with route, never touching the page URL), its app theme scope (transform-gpu, so a fixed sidebar stays in the embed) and an AppNavBoundary: same-app URLs move the embed's route, any other app is onLeave (default: a toast). Knows nothing about demos or where data comes from.",
} satisfies PluginDefinition;
