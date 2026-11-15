import { baIdKind } from "@plugins/conversations/plugins/before-after/core";
import { DEMO_FEATURED_PROTOTYPE } from "./prototypes";

/**
 * The before / after pair the recipes agent registers once it has added the
 * card layouts (v3): the recipes page with the photo cards it had, then with
 * the new overlay cards — the same page, two values of its `cards` option.
 *
 * The PNGs are committed in the demo's `data/before-after/` (a browser host
 * renders nothing), rendered from the prototype's v3 at {@link viewport};
 * the seed registers them through before-after's own write under
 * {@link toolUseId}, which the recipes transcript gives its
 * `register_before_after` call, so the tool row finds its pair.
 */
export const RECIPES_BEFORE_AFTER = {
  id: baIdKind.parse("ba-1792900000-demo01"),
  toolUseId: "toolu_demo_recipes_cards",
  prototype: DEMO_FEATURED_PROTOTYPE,
  title: "Recipe cards: photo vs overlay",
  viewport: { width: 1120, height: 720 },
  before: {
    file: "recipes-cards-photo.png",
    label: "cards: photo",
    picks: { cards: "photo" },
  },
  after: {
    file: "recipes-cards-overlay.png",
    label: "cards: overlay",
    picks: { cards: "overlay" },
  },
} as const;

/** What the seed's registration of {@link RECIPES_BEFORE_AFTER} answered — the tool's text result. */
export interface BeforeAfterRegistration {
  result: string;
}
