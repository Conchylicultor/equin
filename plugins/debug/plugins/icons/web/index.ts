import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { iconsPane } from "./panes";
import { BySetSource, IconsSources, MatrixSource } from "./internal/sources";

export default {
  description:
    "Debug → Icons: every icon name the app draws (the build's icon manifest), plus every inline family's app-only glyphs (family.icon names no Material name maps), as each icon family draws it — Material plus every contributed family — side by side (Matrix) or as one tile grid per family (By set), each cell a real <Icon> under an IconFamilyPreview, badged when it falls back (L / M: the initial of the family drawing it) and dashed when a strict family has a gap. The left list holds every app set (an app whose theme draws in an app-drawn family: own/total over the manifest, +N own glyphs, how far from strict) and every library; a click shows or hides its column. Search, size, Fallbacks only; the body is an icon motion region.",
  contributions: [
    Pane.Register({ pane: iconsPane }),
    DebugApp.Sidebar({
      id: "icons",
      title: "Icons",
      icon: symbol("category"),
      opens: { pane: iconsPane, params: {} },
    }),
    IconsSources({
      id: "matrix",
      title: "Matrix",
      icon: symbol("grid-on"),
      views: ["table"],
      component: MatrixSource,
    }),
    IconsSources({
      id: "by-set",
      title: "By set",
      icon: symbol("grid-view"),
      views: ["icons"],
      component: BySetSource,
    }),
  ],
  slots: { icons: iconsPane, sources: IconsSources },
} satisfies PluginDefinition;
