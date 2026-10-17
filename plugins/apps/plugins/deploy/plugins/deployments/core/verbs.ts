import { z } from "zod";

/**
 * The verbs over a deployment, as the app launches them.
 *
 * **The CLI is the engine; this is only a launcher.** `./singularity deploy
 * converge|ship` owns every refusal, every host mutation and the health gate —
 * the endpoint spawns exactly that command and streams its output. Nothing about
 * converge or ship is re-implemented server-side, which is the same split
 * `release` (CLI) / Studio (UI) already uses.
 *
 * `update` is the exception that proves it: it is **not** a CLI subcommand but a
 * sequence of the two real ones with an engine release between them —
 * `converge → [build a candidate, unless one is already current] → ship
 * --release <runId>`. It re-implements no refusal, no host mutation and no
 * health gate; it only orders things the caller would otherwise have to order by
 * hand. It is the app's one primary action; `converge` and `ship` stay because
 * the row actions and scripted callers still name them individually.
 */
export const DEPLOY_VERBS = ["converge", "ship", "update"] as const;
export const DeployVerbSchema = z.enum(DEPLOY_VERBS);
export type DeployVerb = z.infer<typeof DeployVerbSchema>;

/**
 * Which leg of an `update` is running.
 *
 * Reported as a field rather than parsed out of the log, because the log is the
 * CLI's prose and a UI that scraped it would break the first time a message
 * changed. Null for `converge` and `ship`, whose verb already names their only
 * phase — so "a single-verb run has no phase" is a fact of the type, not a
 * convention.
 */
export const DEPLOY_PHASES = ["converge", "build", "ship"] as const;
export const DeployPhaseSchema = z.enum(DEPLOY_PHASES);
export type DeployPhase = z.infer<typeof DeployPhaseSchema>;
