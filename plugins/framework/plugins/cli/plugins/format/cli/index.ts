import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The escape hatch that makes `format-clean` livable at push time. `push` never
 * builds — it spawns `check --scope tree` in a subprocess — so without this
 * command the only fix for a stray whitespace diff would be a multi-minute
 * build (build lock + Postgres wait + DB fork + every check + vite).
 */
export default defineCliCommand({
  name: "format",
  description:
    "Format every .ts/.tsx changed on this branch (vs merge-base with main) " +
    "with prettier. The SAME pass `./equin build` runs — use it to " +
    "satisfy `format-clean` without paying for a full build. Idempotent.",
  run: () => import("./run"),
});
