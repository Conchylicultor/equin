import {
  ACTIVE_FORM_VERSION,
  LUCIDE_ACTIVE_SPRITE,
  LUCIDE_MAP,
  LUCIDE_SPRITE,
  SETI_SPRITE,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import { readSetiSet, SETI_SET } from "@plugins/ui/plugins/icons/server";
import {
  buildLucideSprites,
  buildSetiSprite,
  LUCIDE_TUNING_VERSION,
  type SpriteDrawerImpl,
} from "@plugins/ui/plugins/icons/plugins/sprites/server";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { loadAcrossReachLoss } from "@plugins/framework/plugins/web-sdk/core";
import { LUCIDE_SET } from "./lucide-set";

/**
 * The sprites a browser host draws: the never-resident ones a scope's icons
 * want — the Seti file-type glyphs (the whole vendored set) and the Lucide
 * glyphs (every name `LUCIDE_MAP` draws). The Material styles and the brands
 * are the page's (its resident sprites): this host holds no set for them.
 */
type Group = typeof SETI_SPRITE | typeof LUCIDE_SPRITE;

function groupOf(key: SpriteKey): Group | null {
  if (key === SETI_SPRITE) return SETI_SPRITE;
  if (key === LUCIDE_SPRITE || key === LUCIDE_ACTIVE_SPRITE)
    return LUCIDE_SPRITE;
  return null;
}

async function build(group: Group): Promise<Map<SpriteKey, string>> {
  if (group === SETI_SPRITE) {
    const set = await readSetiSet();
    return buildSetiSprite(set, Object.keys(set.icons).sort());
  }
  // A chunk fetched over the network: asked again once the device is back
  // if it was lost going offline or to sleep (`loadAcrossReachLoss`).
  return buildLucideSprites(
    await loadAcrossReachLoss(() => LUCIDE_SET.load()),
    Object.keys(LUCIDE_MAP),
  );
}

// One build per group per host, memoized: the sets are parsed once.
const builds = new Map<Group, Promise<Map<SpriteKey, string>>>();
// The groups whose build has landed: a sprite of one is a memory read.
const built = new Set<Group>();

const manifestHash = sha256Hex(
  [
    `${SETI_SET.name}@${SETI_SET.version}`,
    `${LUCIDE_SET.name}@${LUCIDE_SET.version}`,
    JSON.stringify(LUCIDE_MAP),
    LUCIDE_TUNING_VERSION,
    ACTIVE_FORM_VERSION,
  ].join("\n"),
).slice(0, 16);

export const bundledSpriteDrawer: SpriteDrawerImpl = {
  manifestHash,
  draw: async (key) => {
    const group = groupOf(key);
    if (group === null) return { kind: "not-drawn-here" };
    let building = builds.get(group);
    if (building === undefined) {
      // A failed build is not cached: the next read retries (and fails
      // loudly again).
      building = build(group).then(
        (sprites) => {
          built.add(group);
          return sprites;
        },
        (err: unknown) => {
          builds.delete(group);
          throw err;
        },
      );
      builds.set(group, building);
    }
    const markup = (await building).get(key);
    if (markup === undefined)
      throw new Error(`[icons] the bundled "${group}" build has no "${key}"`);
    return { kind: "drawn", markup };
  },
  holds: (key) => {
    const group = groupOf(key);
    return group === null || built.has(group);
  },
};
