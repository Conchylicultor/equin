import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { FilePath } from "./components/file-path";
export { toRelativePath } from "./components/shown-path";

export default {
  collapsed: true,
  description:
    "Clickable file path component with RTL ellipsis, copy button, and file-peek pane integration.",
  contributions: [],
} satisfies PluginDefinition;
