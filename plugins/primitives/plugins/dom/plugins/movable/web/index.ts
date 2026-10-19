import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { Movable, type MovableProps } from "./internal/movable";

export default {
  description:
    "Drag-to-move floating chrome: <Movable bounds> wraps a floating piece (a pinned pill, a tag, a chip) so the user can pull it off whatever it covers — grabbed by its surface, or by one of its buttons once the pointer travels (a plain press stays a click, and the release after a drag never clicks). It stays inside `bounds`, is pulled back in when bounds shrink, and a double-click on its surface sends it home.",
  contributions: [],
} satisfies PluginDefinition;
