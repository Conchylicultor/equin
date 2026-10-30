import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * `./equin promo-film …` — the showcase film's data. `seed` resets this
 * checkout's `promo-film` composition (built with `./equin build --composition
 * promo-film`) to first launch and writes the film's curated story into it.
 */
export default defineCliCommand({
  name: "promo-film",
  description: "The showcase film's instance (the promo-film composition)",
  subcommands: [
    defineCliCommand({
      name: "seed",
      description:
        "Reset this checkout's promo-film composition to first launch (its own database and config only — never main) and write the film's curated story into it. Build it first: ./equin build --composition promo-film",
      run: () => import("./internal/seed"),
    }),
  ],
});
