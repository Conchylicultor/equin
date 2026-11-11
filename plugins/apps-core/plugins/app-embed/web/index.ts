import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  AppEmbed,
  useEmbedPlace,
  type AppEmbedAt,
  type AppEmbedLeave,
  type EmbedPlace,
} from "./components/app-embed";

export default {
  description:
    "<AppEmbed app? route? onLeave? fills? onTitleChange? />: the app rendered in-process inside its own box — an embedded tab set (TabsProvider embedded: seeded from the page URL's place, else app + route, else the composition's home app — non-live stores never touching the page URL, history or storage, none of the page's signals) and the same surface body the app's layout renders, so pane opens, app switches and the Desktop (its windows the embed's own tabs) work as in the app. Its navigation boundary resolves URLs against the apps in scope: an app's URL moves the embed, a surface-mode app's base path switches its mode, anything else is onLeave (default: a toast). Its theme scope is the focused tab's app's (transform-gpu, so fixed chrome stays in the embed); solo fills the embed box, and it opens docked. It keeps its own place in the page URL — the enclosing pane's embed tail, <the page URL>/at/<location>[;full=1] — so a host writes no URL code — never a place no one chose (nothing is written until the user moves it); framed, a move rewrites the current history entry; maximized, each move is the entry the app's own tab would write; Back / Forward move it back; a new browser tab opened inside opens this page there, maximized. useEmbedPlace() gives the host's chrome maximized / setMaximized (a pushed entry) / reset. fills: page | viewport: it is all the page shows (takes the keyboard at mount); a viewport-filling one hosts the page's floating action bar. Its box is a reveal boundary (a reveal inside never scrolls the host page), and onTitleChange hands the host its focused tab's title (<Entity> — <App>). Knows nothing about demos or where data comes from.",
} satisfies PluginDefinition;
