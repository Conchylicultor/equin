import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { seedPromoFilm as seedPromoFilmEndpoint } from "../../core";
import { seedPromoFilm } from "./seed";

export const handleSeed = implementMachine(seedPromoFilmEndpoint, () =>
  seedPromoFilm(),
);
