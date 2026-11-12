// What the seed and the film's recording both name: the state the seed leaves
// for the film to change through the app's own write paths.

/** Sonata's section dock layout (a reorderable slot's config_v2 store path). */
export const SONATA_SECTION_LAYOUT = "apps/sonata/shell/section.jsonc";
/** Sonata's Current key section in that layout — hidden by the seed, shown by the film's Wish. */
export const SONATA_KEY_SECTION = "apps.sonata.rich.key-readout:key-readout";

/**
 * Places' place-cards setting: today's opening hours on the side panel's cards,
 * off by default (so the seed writes nothing). The film's Wish shows them with
 * the Config pane's own write: `setConfigField` with exactly this body.
 */
export const PLACES_HOURS_CONFIG = {
  storePath: "apps/places/places-map/place-cards.jsonc",
  key: "showOpeningHours",
  value: true,
} as const;

/** The app layout (the `Apps.App` slot's reorderable config_v2 store path):
 *  the order every launcher lists apps in, and which ones it hides. */
export const APP_LAYOUT = "apps-core/app.jsonc";
/** Circle in that layout — hidden by the seed, shown at the film's "implement it". */
export const CIRCLE_APP_ITEM = "apps.website.promo-film.circle:circle";
/** The app Circle follows in the film's layout (Circle is film-only, so the
 *  committed layout, main's, does not name it). */
export const CIRCLE_AFTER_ITEM = "apps.browser.shell:browser";

/** Whether a layout node is the item `key` (its bare or `{ item }` form). */
function isItem(node: unknown, key: string): boolean {
  return (
    node === key ||
    (typeof node === "object" &&
      node !== null &&
      (node as { item?: unknown }).item === key)
  );
}

/**
 * The film's app layout: `items` (any layout of {@link APP_LAYOUT} — the
 * committed one, or the film instance's own) with Circle placed right after
 * Browser, carrying the layout's own `hidden` flag or not. Wherever (and
 * whether) `items` had Circle, the result has it in that one place — so the
 * seed's hide and the film's show write the same order. Throws when Browser is
 * not a top-level item.
 */
export function filmAppLayout(
  items: readonly unknown[],
  circle: "hidden" | "shown",
): unknown[] {
  const rest = items.filter((n) => !isItem(n, CIRCLE_APP_ITEM));
  const at = rest.findIndex((n) => isItem(n, CIRCLE_AFTER_ITEM));
  if (at < 0)
    throw new Error(
      `[promo-film] ${CIRCLE_AFTER_ITEM} is not a top-level item of ${APP_LAYOUT}`,
    );
  return [
    ...rest.slice(0, at + 1),
    circle === "hidden"
      ? { item: CIRCLE_APP_ITEM, hidden: true }
      : CIRCLE_APP_ITEM,
    ...rest.slice(at + 1),
  ];
}

/** The pages the film opens (the seed's story ids). */
export const FILM_PAGES_OPENED = {
  /** The Music section: the one the sidebar shows open (its sub-pages visible). */
  music: "block-1792800000-film10",
  /** Music › Buying a piano: the page the user wrote, where the film's Wish adds the shops. */
  buying: "block-1792800000-film14",
} as const;

/**
 * The Buying a piano page's checklist of shops, as the user wrote it (in
 * order, under the heading "Shops"): each a to-do "<shop>: <a line
 * of what it is>", ticked once visited, its place under it. The film's Wish
 * ("Add more piano shops to this page") adds {@link PIANO_SHOPS_ADDED} after
 * them — each a to-do in the same form with a `place` block under it
 * (`parentId: todo`, `{ providerId: "google", placeId }`, which the page
 * resolves itself) — then a map.
 */
export const PIANO_SHOP_LIST: readonly {
  /** The to-do's block id (the seed's story id). */
  todo: string;
  /** The to-do's text: the shop's name, then a line about it. */
  text: string;
  checked: boolean;
  /** The real Google place. */
  placeId: string;
  /** The place block under the to-do (the seed's story id). */
  place: string;
}[] = [
  {
    todo: "block-1792800000-film94",
    text: "Pianos Beaumarchais: only acoustic pianos, lots of second-hand uprights",
    checked: true,
    placeId: "ChIJ-xbedQBy5kcR93lLMItV5cY",
    place: "block-1792800000-film95",
  },
];

/**
 * The shops the film's agent adds after the user's list: each a new to-do
 * (unticked) in the user's own form, right after the last one, its place
 * under it.
 */
export const PIANO_SHOPS_ADDED: readonly { text: string; placeId: string }[] = [
  {
    text: "Pianos International: restored second-hand uprights",
    placeId: "ChIJw7ceIrVv5kcRP56D0taBXhw", // rue de Rome
  },
  {
    text: "Pianos Daudé: new and used, rentals too",
    placeId: "ChIJ368SCJVv5kcRlHbAG4pIcWM", // av. de Wagram
  },
  {
    text: "Nebout & Hamm: a workshop rebuilding vintage pianos",
    placeId: "ChIJj2Fds01u5kcRW-YZsoPgG5Y", // passage de Clichy
  },
];
