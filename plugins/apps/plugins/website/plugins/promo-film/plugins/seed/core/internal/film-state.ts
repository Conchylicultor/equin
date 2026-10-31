// What the seed and the film's recording both name: the state the seed leaves
// for the film to change through the app's own write paths.

/** Sonata's section dock layout (a reorderable slot's config_v2 store path). */
export const SONATA_SECTION_LAYOUT = "apps/sonata/shell/section.jsonc";
/** Sonata's Current key section in that layout — hidden by the seed, shown by the film's Wish. */
export const SONATA_KEY_SECTION = "apps.sonata.rich.key-readout:key-readout";

/**
 * The holiday ideas the film's Wish adds to the "Lisbon in May" page: real
 * Google places (by id), written as `place` blocks the page resolves itself.
 */
export const LISBON_IDEAS: readonly { placeId: string; why: string }[] = [
  {
    placeId: "ChIJm8MOtHc0GQ0R1zPkmUFwwLQ",
    why: "Castelo de São Jorge, for the view over the whole city",
  },
  { placeId: "ChIJV32DNI8zGQ0R9GqiWeuNH2E", why: "Senhora do Monte at sunset" },
  {
    placeId: "ChIJS5zCw0LLHg0RP1FSz63cAjA",
    why: "Belém on Friday afternoon, after the Gulbenkian",
  },
  {
    placeId: "ChIJ5dveYa80GQ0RrEP1FKqq6zM",
    why: "LX Factory on Sunday, for the bookshop",
  },
];
