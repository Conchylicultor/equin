import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * The composition the film is recorded on: the whole app on its own empty
 * database, the only one carrying this seed (`plugin-meta/composition`'s
 * `promo-film` row; every other composition inherits the base exclusion of
 * `apps.website.promo-film.seed`).
 */
export const PROMO_FILM_COMPOSITION_ID = "promo-film";

/** What the seed wrote, for the CLI to print. */
export const PromoFilmSeedReportSchema = z.object({
  namespace: z.string(),
  /** Each step, in order, with what it wrote. */
  steps: z.array(z.object({ step: z.string(), wrote: z.string() })),
});
export type PromoFilmSeedReport = z.infer<typeof PromoFilmSeedReportSchema>;

/**
 * Write the film's whole story into this instance. Answered only by the
 * `promo-film` composition's backend, and only on a first-launch database
 * (`./equin promo-film seed` resets it just before): anything else is refused
 * before a row is written.
 */
export const seedPromoFilm = defineEndpoint({
  route: "POST /api/promo-film/seed",
  response: PromoFilmSeedReportSchema,
  needsMachine: { feature: "Seeding the showcase film's instance" },
});
