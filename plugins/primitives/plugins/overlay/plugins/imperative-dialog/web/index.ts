import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useOpenDialog,
  type DialogOptions,
  type OpenDialog,
} from "./internal/open-dialog";

export default {
  description:
    "Imperative dialog primitive: useOpenDialog() returns openDialog(render), which mounts a modal Dialog from any callback (create affordances, confirms) in the caller's render origin — so the dialog reads the caller's transport, registry and navigator, never the page's from inside a scope. Returns a promise that resolves when the dialog closes.",
  contributions: [],
} satisfies PluginDefinition;
