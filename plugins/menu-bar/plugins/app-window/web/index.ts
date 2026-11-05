import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useNativeFileDrag,
  type NativeFileDrag,
} from "./internal/native-file-drag";

export default {
  description:
    "An installed app window's bridge to the native helper (window.equinWindow), read once per document: useNativeFileDrag() is the window's native file drag — drag host paths out as real files, the drag Finder starts, so any app or website takes them — or null in a browser tab, on a platform without it, or before the window has answered.",
} satisfies PluginDefinition;
