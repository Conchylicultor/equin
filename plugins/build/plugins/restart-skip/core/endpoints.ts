import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * What a deploy is about to spawn, asked of the backend it would replace.
 * Absolute paths, so the backend compares them with what it runs on, not with
 * what a spec spells.
 */
export const AdoptRequestSchema = z.object({
  /** The Bun binary the new spec's `command` runs. */
  bin: z.string().min(1),
  /** The serving entry the new spec's `command` runs. */
  entry: z.string().min(1),
  /** The commit the deploy was built from — what the backend now stands for. */
  commit: z.string().min(1),
});
export type AdoptRequest = z.infer<typeof AdoptRequestSchema>;

/**
 * The backend's answer. `adopted`: a process spawned now would run exactly the
 * code this one runs, and this one now stands for the deploy — no restart.
 * `restart`: it cannot vouch for that, and `reason` says why.
 */
export const AdoptVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adopted") }),
  z.object({ kind: z.literal("restart"), reason: z.string() }),
]);
export type AdoptVerdict = z.infer<typeof AdoptVerdictSchema>;

/**
 * Ask the running backend to adopt a deploy instead of being restarted. A
 * write: on `adopted` the backend re-pins what it stands for (its commit, the
 * web graph it judges tabs against).
 */
export const adoptDeploy = defineEndpoint({
  route: "POST /api/build/restart-skip/adopt",
  needsMachine: { feature: "Keeping a backend across deploys" },
  internal: { why: "asked by `./equin build` of the backend it would restart" },
  body: AdoptRequestSchema,
  response: AdoptVerdictSchema,
});

/**
 * The same question asked of central (a route of its own: the gateway sends
 * central every path central serves, and a backend serves the one above).
 * Central has no per-deploy memo, so `adopted` changes nothing in it.
 */
export const adoptCentralDeploy = defineEndpoint({
  route: "POST /api/restart-skip/central/adopt",
  internal: {
    why: "asked by main's `./equin build` of central before restarting it",
  },
  body: AdoptRequestSchema,
  response: AdoptVerdictSchema,
});
