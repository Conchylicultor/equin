import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ToasterHost } from "./components/toaster-host";
import { ToastLayer } from "./internal/layer";

export { showToast } from "./internal/show-toast";
export { isInToast } from "./internal/is-in-toast";
export { useSuppressToasts } from "./internal/suppress-toasts";
export { type ToastArgs, type ToastVariant } from "../core";

export default {
  description:
    "Global toast notifications: a plain showToast() backed by sonner's global API, plus the Core.Root-mounted sonner Toaster host. Degrades to a silent no-op when no host is mounted. A toast declaring audience developer is shown only in Developer mode. useSuppressToasts() lets a surface that is its whole document (the menu-bar panel) turn the host off while mounted.",
  contributions: [
    Core.Root({ component: ToasterHost }),
    ToastLayer.contribution,
  ],
} satisfies PluginDefinition;
