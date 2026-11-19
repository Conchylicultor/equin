import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { buildRunKind } from "./internal/arm";

export default {
  description:
    "The build arm of the merged run space: binds `build_runs` into the runs union, mapping the seven-way BuildStatus taxonomy onto the shared outcome axis while keeping it whole as the `build.status` arm field, plus the targets, commit and exit code only a build row has.",
  register: [buildRunKind],
} satisfies ServerPluginDefinition;
