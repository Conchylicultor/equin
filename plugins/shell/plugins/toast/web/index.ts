import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ToasterHost } from "./components/toaster-host";
import { ToastLayer } from "./internal/layer";

export { useShowCustomToast } from "./internal/show-toast";
export { isInToast } from "./internal/is-in-toast";
export { useSuppressToasts } from "./internal/suppress-toasts";
export type { CustomToastArgs } from "./internal/show-toast";

export default {
  description:
    "The toast stack: useShowCustomToast() — a toast whose content the caller draws, rendered in the caller's render origin (its transport, registry and navigator) while the stack only places it, plus the Core.Root-mounted sonner Toaster host. Feature code never raises a toast here: useToast (shell/notifications) shows every toast through it AND records it in the notification history; the shell-toast/no-direct-custom-toast lint rule keeps it so. Degrades to a silent no-op when no host is mounted. A toast declaring audience developer is shown only in Developer mode. A custom toast states why it is shown: an announcement (something that happened on its own, e.g. a notification arriving) is raised only on a page on screen and always leaves after the announcement duration, whatever its variant; a reply (the answer to the user's own action) stays as long as its caller says, Infinity included. useSuppressToasts() lets a surface that is its whole document (the menu-bar panel) turn the host off while mounted.",
  contributions: [
    Core.Root({ component: ToasterHost, scope: "page" }),
    ToastLayer.contribution,
  ],
} satisfies PluginDefinition;
