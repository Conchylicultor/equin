import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { finishFilmAgentRun, seedPromoFilm, writeFilmShops } from "../core";
import { handleAgentRun } from "./internal/handle-agent-run";
import { handleAgentShops } from "./internal/handle-agent-shops";
import { handleSeed } from "./internal/handle-seed";

export default {
  description:
    "The showcase film's seed: POST /api/promo-film/seed writes the film's curated story (an organised Pages workspace with the agent's note on the Piano page, a Grieg conversation with its transcript and its score and MIDI files, twenty other agent runs, saved places across Europe, the Circle prototype) through each app's own write path; POST /api/promo-film/agent-run finishes the agent run of a task the film's Wish filed (its conversation and transcript); POST /api/promo-film/agent-shops is the shops agent's one edit_page on Buying a piano (every added shop with its place, a blank line and a map, in one apply). Booted only by the promo-film composition, and refused anywhere but its own instance.",
  httpRoutes: {
    [seedPromoFilm.route]: handleSeed,
    [finishFilmAgentRun.route]: handleAgentRun,
    [writeFilmShops.route]: handleAgentShops,
  },
} satisfies MachinePluginDefinition;
