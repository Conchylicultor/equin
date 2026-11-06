import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { ALL_STYLE_KEYS } from "@plugins/ui/plugins/icons/core";
import {
  RuntimeSymbolDrawer,
  savedIconNames,
} from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { bundledSymbolsDrawer, drawAndKeep } from "./internal/drawer";

export default {
  description:
    "The saved-icon drawings of a host without the computer's icon sets (the browser composition): provides the RuntimeSymbolDrawer from the Material Symbols set bundled with the worker (weight 400, every shape and fill; a light style draws its 400 drawing), loaded lazily and only on a miss. Its warm-up draws every saved name in every style and keeps those drawings in the host's storage (a picker's are held in memory only), so a build-time snapshot ships the demo's icons drawn and a visitor never loads the set for them. Never booted by the desktop.",
  contributions: [RuntimeSymbolDrawer.provide(bundledSymbolsDrawer)],
  register: [
    defineWarmup({
      name: "icons.bundled-symbols.draw-saved",
      description:
        "Draw every saved icon name in every style into the host's storage (the snapshot carries them)",
      scope: "worktree",
      run: async () => {
        const names = await savedIconNames();
        for (const key of ALL_STYLE_KEYS) {
          await drawAndKeep(key, names);
        }
      },
    }),
  ],
} satisfies ServerPluginDefinition;
