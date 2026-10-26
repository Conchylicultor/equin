import { defineZLayer } from "@plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/web";

/** Toasts and their Dismiss all strip — its place on the top-layer stack (z-layers/stack). */
export const ToastLayer = defineZLayer({
  id: "toast",
  label: "Toasts and their Dismiss all strip",
});
