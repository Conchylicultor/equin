import { defineZLayer } from "@plugins/primitives/plugins/css/plugins/z-layers/plugins/stack/web";

/** The draw-on-app full-screen capture overlay — its place on the top-layer stack (z-layers/stack). */
export const DrawLayer = defineZLayer({
  id: "draw",
  label: "The draw-on-app full-screen capture overlay",
});
