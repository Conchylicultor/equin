import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  commitsCountsByCategoryServed,
  commitsCountsServed,
  commitsLinesByExtServed,
  commitsLinesServed,
} from "./internal/served";

export default {
  description:
    "Commit stats, desktop-only half: the commit-count and lines-changed live values, series over `git log` of the main checkout, so a host without the computer answers them unavailable.",
  contributions: [
    ...commitsCountsServed.declare,
    ...commitsCountsByCategoryServed.declare,
    ...commitsLinesServed.declare,
    ...commitsLinesByExtServed.declare,
  ],
} satisfies MachinePluginDefinition;
