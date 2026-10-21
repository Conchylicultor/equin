import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Movable, type MovableAt, type MovableProps } from "./internal/movable";
export {
  useDragGesture,
  type DragGestureHandlers,
  type DragPoint,
} from "./internal/use-drag-gesture";

export default {
  description:
    "Drag-to-move floating chrome: <Movable at bounds> is a placed floating piece (a pill, a tag, a chip — `at` places it as a Pin step or Placed coordinates and it IS that positioned element, so nothing is left at home after a drag) the user can pull off whatever it covers — grabbed by its surface, or by one of its buttons once the pointer travels (a plain press stays a click, and the release after a drag never clicks). It stays inside `bounds`, is pulled back in when bounds shrink, and a double-click on its surface sends it home. The gesture itself is useDragGesture — the onPointerDown of a handle (threshold on buttons, capture at drag start, the post-drag click swallowed) — for a piece that places itself.",
  contributions: [],
} satisfies PluginDefinition;
