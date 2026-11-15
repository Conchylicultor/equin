import {
  baIdKind,
  type BaId,
} from "@plugins/conversations/plugins/before-after/core";
import { DEMO_FEATURED_PROTOTYPE } from "./prototypes";

/**
 * A before / after pair an agent of the story registers. The PNGs are
 * committed in the demo's `data/before-after/` (a browser host renders
 * nothing), at {@link viewport}; the seed registers each pair through
 * before-after's own write under {@link toolUseId}, which the story's
 * transcript gives its `register_before_after` call, so the tool row finds
 * its pair.
 */
export interface DemoBeforeAfter {
  /** The story whose conversation registers it. */
  story: string;
  id: BaId;
  toolUseId: string;
  title: string;
  viewport: { width: number; height: number };
  /** The prototype both sides show, when the pair compares two of its variants. */
  prototype?: string;
  before: DemoBeforeAfterSide;
  after: DemoBeforeAfterSide;
}

/** One side of a pair: its committed PNG, its label, and the prototype option picks it shows (if any). */
interface DemoBeforeAfterSide {
  file: string;
  label: string;
  picks?: Readonly<Record<string, string>>;
}

/**
 * The recipes agent, once it has added the card layouts (v3): the recipes
 * page with the photo cards it had, then with the new overlay cards — the
 * same page, two values of its `cards` option.
 */
export const RECIPES_BEFORE_AFTER = {
  story: "recipes",
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
} as const satisfies DemoBeforeAfter;

/**
 * The practice-timer agent, once its preview is checked: Sonata's library in
 * its Recent view on main, then on the preview with the new This week column
 * (1 min on the ii–V–I warm-up it played).
 */
export const PRACTICE_TIMER_BEFORE_AFTER = {
  story: "practice-timer",
  id: baIdKind.parse("ba-1792900000-demo02"),
  toolUseId: "toolu_demo_practice_timer_library",
  title: "Sonata library, Recent view: This week column",
  viewport: { width: 1600, height: 760 },
  before: { file: "practice-timer-library-main.png", label: "main" },
  after: { file: "practice-timer-library-preview.png", label: "this build" },
} as const satisfies DemoBeforeAfter;

/** Every pair the seed registers. */
export const BEFORE_AFTERS: readonly DemoBeforeAfter[] = [
  RECIPES_BEFORE_AFTER,
  PRACTICE_TIMER_BEFORE_AFTER,
];

/** What the seed's registration of a pair answered — the tool's text result. */
export interface BeforeAfterRegistration {
  result: string;
}

/** The seed's registrations, by pair id. */
export type BeforeAfterRegistrations = Readonly<
  Record<string, BeforeAfterRegistration>
>;
