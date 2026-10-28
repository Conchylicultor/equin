import type {
  PrototypeFixture,
  PrototypeFixtureData,
  PrototypeFixtureTag,
} from "@plugins/apps/plugins/prototypes/plugins/fixtures/core";

// The demo's Prototypes gallery: the committed `data/` (prototypes/ and their
// pre-rendered thumbnails/, in the prototypes fixture layout — see
// `apps/prototypes/fixtures`) plus the gallery rows the demo wants on top of
// it. The layout, its parser and its writer are the app's; which prototypes,
// tags and pin the demo shows are the demo's.

/** The demo's prototype tags, in gallery order, and which prototype carries which. */
export const DEMO_PROTOTYPE_TAGS: readonly PrototypeFixtureTag[] = [
  {
    id: "prtag-1792900000-demo01",
    name: "Lumen",
    color: "purple",
    carriers: ["proto-1792900000-demo01"],
  },
  {
    id: "prtag-1792900000-demo02",
    name: "Agent manager",
    color: "blue",
    carriers: ["proto-1792900060-demo02", "proto-1792900120-demo03"],
  },
];

/** The prototype pinned to the top of the gallery. */
export const DEMO_PINNED_PROTOTYPE = "proto-1792900000-demo01";

/**
 * The fixture the seed writes: `data`'s files with the demo's tags and pin.
 * Loud on a prototype folder whose id does not carry `demo` — every demo id
 * does, so a request that leaked to the real server is findable in its logs.
 */
export function demoPrototypeFixture(
  data: PrototypeFixtureData,
): PrototypeFixture {
  const undemo = [
    ...new Set(Object.keys(data.tree).map((path) => path.split("/")[0]!)),
  ].filter((top) => !top.startsWith("_") && !top.includes("demo"));
  if (undemo.length > 0)
    throw new Error(
      `[demo] prototype folders must carry "demo" in their id (proto-<epoch>-demoNN): ${undemo.join(", ")}`,
    );
  return {
    ...data,
    tags: DEMO_PROTOTYPE_TAGS,
    pinned: [DEMO_PINNED_PROTOTYPE],
  };
}
