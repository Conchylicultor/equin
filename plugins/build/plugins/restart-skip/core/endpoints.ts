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
 * `restart`: something it runs (or could still load) changed, or a declared
 * limit keeps it from vouching (another Bun, a child of unknown code) —
 * `reason` says what.
 * `cannot-judge`: the measurement itself broke — the closure walk refused the
 * code on disk (an import it cannot resolve, a computed load). The deploy
 * restarts all the same (never a guess), but this is a defect of the
 * judgement, not a fact about the deploy: left to read as a `restart`, it
 * turns restart-skip off silently on every deploy until someone notices
 * (2026-11: 19 of 39 main deploys, for a lazy `import("@browser-host/…")`).
 * The deploy files it as a `restart-skip-cannot-judge` report.
 */
export const AdoptVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adopted") }),
  z.object({ kind: z.literal("restart"), reason: z.string() }),
  z.object({ kind: z.literal("cannot-judge"), reason: z.string() }),
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

/** The report kind a deploy files when the process it asked `cannot-judge`. */
export const CANNOT_JUDGE_REPORT_KIND = "restart-skip-cannot-judge";

/**
 * Its payload: which process could not judge — a namespace's backend, or
 * central (one per machine, `namespace: null`) — and the judgement's own
 * words for why.
 */
export const CannotJudgePayloadSchema = z.object({
  process: z.enum(["backend", "central"]),
  namespace: z.string().nullable(),
  reason: z.string(),
});
export type CannotJudgePayload = z.infer<typeof CannotJudgePayloadSchema>;
