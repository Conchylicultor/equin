import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ToasterHost } from "./components/toaster-host";

export { showToast } from "./internal/show-toast";
export { isInToast } from "./internal/is-in-toast";
export { type ToastArgs, type ToastVariant } from "../core";

export default {
  description:
    "Global toast notifications: a plain showToast() backed by sonner's global API, plus the Core.Root-mounted sonner Toaster host. Degrades to a silent no-op when no host is mounted.",
  contributions: [Core.Root({ component: ToasterHost })],
} satisfies PluginDefinition;
