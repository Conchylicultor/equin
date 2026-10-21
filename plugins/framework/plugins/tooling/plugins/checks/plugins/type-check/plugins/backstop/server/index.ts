import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { typeCheckBackstopJob } from "./internal/backstop-job";
import { typeCheckDivergenceKind } from "./internal/divergence-kind";

export default {
  description:
    "The two-program type check's backstop: a daily main-only job runs the type-check worker in dual mode (the two-program check beside a full check of a fresh whole program, compared file by file) and files a type-check-divergence report for every file whose result differs.",
  register: [typeCheckBackstopJob],
  contributions: [typeCheckDivergenceKind],
} satisfies ServerPluginDefinition;
