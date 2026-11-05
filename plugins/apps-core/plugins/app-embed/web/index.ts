import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { AppEmbed, type AppEmbedLeave } from "./components/app-embed";

export default {
  description:
    "<AppEmbed app route onLeave? />: the app rendered in-process inside its own box — an embedded tab set (TabsProvider embedded: seeded with app + route, non-live stores never touching the page URL, history or storage, none of the page's signals) and the same surface body the app's layout renders, so pane opens, app switches and the Desktop (its windows the embed's own tabs) work as in the app. Its navigation boundary resolves URLs against the apps in scope: an app's URL moves the embed, a surface-mode app's base path switches its mode, anything else is onLeave (default: a toast). Its theme scope is the focused tab's app's (transform-gpu, so fixed chrome stays in the embed); solo fills the embed box, and it opens docked. Knows nothing about demos or where data comes from.",
} satisfies PluginDefinition;
