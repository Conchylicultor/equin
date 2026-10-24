import type { TagRow } from "@plugins/tag-tree/plugins/engine/core";
import type { TagPickerWrites } from "../../web/internal/types";

const at = new Date(0);

function tag(
  id: string,
  name: string,
  parentId: string | null,
  rank: string,
  color: string | null = null,
): TagRow {
  return {
    id,
    name,
    parentId,
    rank,
    color,
    childColors: null,
    icon: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** The approved mockup's tree: app ▸ website ▸ homepage, chord, places; infra ▸ data-view; theme. */
export const FIXTURE_TAGS: readonly TagRow[] = [
  tag("app", "app", null, "a0", "#a855f7"),
  tag("app-website", "website", "app", "a0"),
  tag("app-website-home", "homepage", "app-website", "a0"),
  tag("app-chord", "chord", "app", "a1", "#ec4899"),
  tag("app-places", "places", "app", "a2"),
  tag("infra", "infra", null, "a1", "#16a34a"),
  tag("infra-data-view", "data-view", "infra", "a0"),
  tag("theme", "theme", null, "a2", "#ef4444"),
];

/** Rolled-up prototype counts, as the gallery would pass them. */
export const FIXTURE_COUNTS: ReadonlyMap<string, number> = new Map([
  ["app", 7],
  ["app-website", 3],
  ["app-website-home", 1],
  ["app-chord", 2],
  ["app-places", 1],
  ["infra", 1],
  ["infra-data-view", 1],
  ["theme", 1],
]);

/** An exhibit writes nothing: every edit resolves and changes nothing. */
export const NO_WRITES: TagPickerWrites = {
  create: () => Promise.resolve({ id: "" }),
  createPath: () => Promise.resolve({ id: "", created: [] }),
  update: () => Promise.resolve(),
  move: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};
