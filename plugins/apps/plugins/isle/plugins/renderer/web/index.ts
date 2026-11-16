import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { IsleEngine, ISLE_FONTS } from "./internal/engine";
export { useIslandShapes } from "./internal/shapes";
export type { IslandShapes } from "./internal/shapes";
export type {
  ClickModifiers,
  EngineHooks,
  EngineOptions,
  IsleApp,
  IsleLife,
  IsleViewState,
  TimeOfDay,
} from "./internal/engine";

export default {
  description:
    "Isle's canvas engine (IsleEngine): the archipelago drawn from the pure world — 512 px tiles in a ground and an object layer with the animated water between, baked centre-first within a frame's budget (another zoom's tile standing in), scenery, buildings painted once per time of day with alpha hit masks and a hover glow, people cut out by what stands in front, signposts, map labels, the time of day's tint and lights, signs of life by how much each app is used (chimney smoke, windows lit at dusk, a villager lingering at the door; none while that is not known); easter eggs (a werewolf prowling the outskirts at night — howling at the moon, bolting from the hero —, bats round the campfire at dusk); sound hooks (footsteps, hover); input (drag with inertia, wheel / pinch zoom at the cursor, click to open or walk with A*, double-click the ground to teleport there (the hero drawn up into a column of light and dropped out of another), arrows / WASD, drag a building to move it — a finger holds on it first). React only mounts it. The expensive bakes run in a pool of module workers (bake.worker.ts, bundled whole by web-artifacts' worker pass): ground tiles' per-pixel colour and water mask, island previews, each island's furniture (coast, boulders, trees), buildings' hit masks (read in idle time) — and island shapes and the home carve, built ahead by useIslandShapes for what a placement reads — with the very same code as the page, so the pixels are identical; where workers cannot run, everything bakes on the page.",
  contributions: [],
} satisfies PluginDefinition;
