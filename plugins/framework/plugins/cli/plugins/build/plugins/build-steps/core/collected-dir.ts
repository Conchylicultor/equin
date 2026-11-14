import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// Marks `build-step` as a collected dir: codegen scans core files for this
// marker and emits `build-step.generated.ts`, registering every plugin's
// `build-step/index.ts` (default export: `defineBuildStep` values). A plugin
// contributing a build step needs no edit to `./equin build`.
//
// Composition membership: a step belongs to the app the build deploys, so a
// plugin the composition excludes contributes none.
//
// Not re-exported from the `core` barrel: the registry's loaders reach
// host-only code; `runBuildSteps()` (`cli/`) is the one reader.
export const buildStepCollectedDir = defineCollectedDir("build-step");
