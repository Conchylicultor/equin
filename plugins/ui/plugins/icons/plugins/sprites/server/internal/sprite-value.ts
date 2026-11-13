import { serveValue } from "@plugins/network/plugins/live/server";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { isSpriteKey } from "@plugins/ui/plugins/icons/core";
import { getSpriteAsset, iconSprite, spriteHash } from "../../core";
import { SpriteDrawer } from "./sprite-drawer";

/**
 * One sprite on demand, content-addressed by the drawer's hash: external and
 * `immutable` — this host answers only its own hash, and the sprite is a pure
 * function of what that hash covers (the drawer memoizes its builds). Its
 * ETag is the tuple itself while `hash` is this host's — so a tab replaying it
 * after a restart that kept the hash is answered `up-to-date` instead of
 * re-sent the sprite — and a value no stored ETag can equal otherwise (that
 * tuple is refused `stale-manifest`).
 */
export const iconSpriteServed = serveValue(iconSprite, {
  source: "external",
  // A slice of the drawer's per-host memo (one build per sprite group,
  // shared by every reader): no slot, never queued behind git reads.
  readCost: "memory",
  changes: {
    immutable: {
      reason: "content-addressed by the drawer's hash",
    },
  },
  revalidate: ({ hash, key }) => {
    const current = SpriteDrawer.get().manifestHash;
    return Promise.resolve(
      hash === current ? `${hash}/${key}` : `stale-manifest/${current}`,
    );
  },
  loader: async ({ hash, key }) => {
    const drawer = SpriteDrawer.get();
    if (hash !== drawer.manifestHash) {
      throw iconSprite.refuse(
        "stale-manifest",
        `Sprite version ${hash} is not this server's (${drawer.manifestHash})`,
      );
    }
    if (!isSpriteKey(key)) {
      throw iconSprite.refuse("unknown-key", `No sprite is named "${key}"`);
    }
    const drawn = await drawer.draw(key);
    if (drawn.kind === "not-drawn-here") {
      throw iconSprite.refuse(
        "not-drawn-here",
        `This host holds no icon set to draw the "${key}" sprite from`,
      );
    }
    return drawn.markup;
  },
});

/** The drawer's hash: fixed for the host's life. */
export const spriteHashServed = serveValue(spriteHash, {
  source: "external",
  readCost: "memory",
  changes: {
    fixed: {
      reason: "a pure function of the drawer's names, sets and tuning",
    },
  },
  loader: () => Promise.resolve(SpriteDrawer.get().manifestHash),
});

/**
 * `GET /api/icons/sprite-assets/:hash/:key` — one sprite as an asset the
 * browser caches for good: the path carries the drawer's hash, so a changed
 * manifest is a different URL, never a stale hit. The shell's head fetches
 * the resident ones at t0 (`head.ts`).
 */
export const handleSpriteAsset = rawEndpointHandler(
  getSpriteAsset,
  async (_req, params) => {
    const drawer = SpriteDrawer.get();
    const key = params.key ?? "";
    if (params.hash !== drawer.manifestHash) {
      return new Response(
        `Sprite version ${params.hash} is not this server's (${drawer.manifestHash})`,
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    const drawn = isSpriteKey(key) ? await drawer.draw(key) : null;
    if (drawn === null || drawn.kind === "not-drawn-here") {
      return new Response(`This host draws no sprite named "${key}"`, {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response(drawn.markup, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  },
);
