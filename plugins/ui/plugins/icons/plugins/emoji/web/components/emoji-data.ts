import type { EmojiDataResolver } from "frimousse";
import { transportScoped } from "@plugins/primitives/plugins/networking/web";
import { assetFetchOver } from "@plugins/infra/plugins/endpoints/web";
import { assetMirrorBase } from "@plugins/infra/plugins/asset-mirror/core";
import { EMOJIBASE_MIRROR_ID } from "../../shared/mirror";
import { emojibaseResolver } from "./emojibase";
import { drawsCountryFlags } from "./country-flags";

const EMOJIBASE = assetMirrorBase(EMOJIBASE_MIRROR_ID);

/**
 * How the picker gets its data on one transport:
 * - `ready` — `resolve` is the frimousse resolver over the emojibase mirror,
 *   fetched THROUGH the transport (`assetFetchOver`): the page's own server,
 *   or an in-browser server's answer — so a demo's picker never asks the
 *   page's server, and every host takes the same path;
 * - `unavailable` — the mirror's route needs the computer and none is behind
 *   the transport (`message` says so).
 */
export type EmojiDataSource =
  | { readonly kind: "ready"; readonly resolve: EmojiDataResolver }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * One source per transport, its data loaded once and shared by every picker
 * mounted on it (frimousse's own resolver kept one per URL). A failed load is
 * forgotten, so the next mount asks again.
 */
export const emojiDataSources = transportScoped(
  (transport): EmojiDataSource => {
    const asset = assetFetchOver(transport, EMOJIBASE);
    if (asset.kind === "unavailable") return asset;
    // Handed over as a value: the resolver fetches through the transport's
    // hook, never a fetch of its own (Sonata's samplers take it the same way).
    return {
      kind: "ready",
      resolve: emojibaseResolver(asset.base, asset.fetch, drawsCountryFlags),
    };
  },
);
