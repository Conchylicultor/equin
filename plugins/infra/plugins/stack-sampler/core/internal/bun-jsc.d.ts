// `samplingProfilerStackTraces` exists at runtime but is absent from bun-types
// (1.3.x), so it is declared here. Its return is declared `unknown` on purpose:
// the observed shape is `{ interval, traces: [{ timestamp, frames: [{ sourceID,
// name, location, sourceURL?, line, column, category, flags }] }] }`, but no
// type verifies it, so the one path from it to a typed value is
// `normalizeTraces` (`./sampler.ts`), which checks what it reads.
//
// A declaration-only file: an augmentation is seen by every file without being
// imported, so the type check keys every file on this file's version — in a
// source file, every edit to it would re-check the whole repo
// (`type-check/no-global-declaration-in-source`). A module (the `export {}`),
// so the block below augments bun's own `bun:jsc` rather than replacing it.
export {};

declare module "bun:jsc" {
  export function samplingProfilerStackTraces(): unknown;
}
