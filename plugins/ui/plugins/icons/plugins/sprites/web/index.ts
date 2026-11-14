import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Icons } from "@plugins/ui/plugins/icons/web";
import { iconSpritesBootTask } from "./internal/boot";
import { IconSpriteHost } from "./internal/sprite-host";

export { ScopeIconSymbols } from "./internal/sprite-host";

export default {
  description:
    "Mounts the page's icons inline, loaded glyph by glyph: every Material and Lucide glyph an <Icon> wants is batched per commit and read live (icons.runtime-symbols), and the page's first paint waits for its first frame's glyphs. The glyph batches a page's last first frame drew are remembered in localStorage and fetched by the SPA shell's head at t0 (content-addressed assets the browser caches), with the resident brands sprite, and provided by a Core.Boot task before the first render — a warm first frame wants nothing. The Seti sprite is read whole on demand. ScopeIconSymbols gives a plugin scope (a demo) a glyph store of its own, read from the scope's server and drawn in a sheet inside it.",
  contributions: [
    iconSpritesBootTask,
    Icons.Root({ component: IconSpriteHost, companion: true, scope: "page" }),
  ],
} satisfies PluginDefinition;
