import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { IconSpriteHost } from "./internal/sprite-host";

export { ScopeIconSymbols } from "./internal/sprite-host";

export default {
  description:
    "Mounts the page's icon sprites inline: the resident default-style sprites from the boot snapshot (present at first paint) plus, on demand, the sprite of every other style a theme scope picks, and the page's saved-icon symbols. ScopeIconSymbols gives a plugin scope (a demo) saved icons of its own, read from the scope's server and drawn in a sheet inside it.",
  contributions: [Icons.Root({ component: IconSpriteHost, companion: true })],
} satisfies PluginDefinition;
