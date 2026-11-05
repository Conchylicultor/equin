import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useConfirmDialog,
  type ConfirmDialog,
  type ConfirmDialogOptions,
} from "./internal/confirm-dialog";

export default {
  description:
    "useConfirmDialog() → confirm(opts) → Promise<boolean>: a destructive-confirm helper over useOpenDialog (rendered in the caller's render origin). Renders a sm panel (title + description + optional children + inline error + Cancel/Confirm), keeps the dialog open and shows getEndpointErrorMessage on failure, and resolves true iff onConfirm completed.",
  contributions: [],
} satisfies PluginDefinition;
