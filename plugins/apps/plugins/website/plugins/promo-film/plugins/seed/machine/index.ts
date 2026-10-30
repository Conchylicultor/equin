import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { seedPromoFilm } from "../core";
import { handleSeed } from "./internal/handle-seed";

export default {
  description:
    "The showcase film's seed: POST /api/promo-film/seed writes the film's curated story (the piano wiki, the practice-file conversation and its transcript and workspace files, a tidy task list, the Lisbon places, a deploy history, the Circle prototype) through each app's own write path. Booted only by the promo-film composition, and refused anywhere but its own first-launch database.",
  httpRoutes: {
    [seedPromoFilm.route]: handleSeed,
  },
} satisfies MachinePluginDefinition;
