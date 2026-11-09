import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  AppEmbed,
  type AppEmbedAt,
  type AppEmbedLeave,
} from "./components/app-embed";

export default {
  description:
    "<AppEmbed app route | url onLeave? fills? onLocationChange? browserTabUrl? />: the app rendered in-process inside its own box — an embedded tab set (TabsProvider embedded: seeded with app + route or an app-rooted URL — undefined: the composition's home app — non-live stores never touching the page URL, history or storage, none of the page's signals) and the same surface body the app's layout renders, so pane opens, app switches and the Desktop (its windows the embed's own tabs) work as in the app. Its navigation boundary resolves URLs against the apps in scope: an app's URL moves the embed, a surface-mode app's base path switches its mode, anything else is onLeave (default: a toast). Its theme scope is the focused tab's app's (transform-gpu, so fixed chrome stays in the embed); solo fills the embed box, and it opens docked. It tells its host its location (the focused tab's app-rooted URL, mode prefix included) so the host can keep it and reopen there, and a new browser tab opened inside it is addressed by the host (browserTabUrl) when given. fills: page | viewport: it is all the page shows (takes the keyboard at mount); a viewport-filling one hosts the page's floating action bar. Knows nothing about demos or where data comes from.",
} satisfies PluginDefinition;
