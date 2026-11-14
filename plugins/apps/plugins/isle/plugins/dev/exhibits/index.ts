import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";
import { isleApp } from "@plugins/apps/plugins/isle/plugins/shell/core";

// App exhibit: the engine reads the live app (its theme, the icon fonts), and
// the world grows in memory — nothing here writes the real `isle.plots`.
export default [
  appExhibit({
    id: "isle/growth",
    label: "Isle growth (made-up apps)",
    description:
      "The island with 14…142 made-up apps, placed in memory: grow it, shrink it, change the seed, and compare baking in workers with baking on the page.",
    home: isleApp,
    widths: [1280],
    load: () => import("./internal/growth"),
  }),
];
