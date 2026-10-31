import { defineZLayer } from "@plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/web";

/** The element picker's armed full-screen overlay — its place on the top-layer stack (z-layers/stack). */
export const PickerLayer = defineZLayer({
  id: "element-picker",
  label: "The element picker's armed full-screen overlay",
});
