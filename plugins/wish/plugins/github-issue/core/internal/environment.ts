import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * Where the code this backend serves stands against the trunk it came from.
 *
 * - `unknown` — the backend cannot name the commit it runs (a mixed boot:
 *   the checkout moved while its plugins loaded), so there is nothing to
 *   measure; `reason` says why.
 * - `commit` — the commit it runs; `release`, the newest release in that
 *   commit's history (null: it holds none); `base`, the trunk it is measured
 *   against (`upstream/main` on a clone, as of the last update check; `main`
 *   on the canonical repo, or where no upstream is known); `ahead`, its
 *   commits the trunk does not have (local changes); `behind`, the trunk's
 *   commits it does not have.
 */
export const IssueCodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown"), reason: z.string() }),
  z.object({
    kind: z.literal("commit"),
    commit: z.string(),
    release: z.string().nullable(),
    base: z.string(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
  }),
]);
export type IssueCode = z.infer<typeof IssueCodeSchema>;

/**
 * What a GitHub issue filed from this instance says about the machine and
 * the code serving it — the half only the backend knows (the browser adds
 * its own). `system` is the operating system the backend runs on, with its
 * version and architecture (`macOS 26.4 (arm64)`); `runtime`, the Bun that
 * runs it.
 */
export const IssueEnvironmentSchema = z.object({
  system: z.string(),
  runtime: z.string(),
  code: IssueCodeSchema,
});
export type IssueEnvironment = z.infer<typeof IssueEnvironmentSchema>;

/**
 * The live environment, read when the Wish popover's File on GitHub button
 * draws. Git is half its truth, so it needs the computer: under an in-browser
 * server the read is `unavailable`, and the issue carries the browser's half
 * only.
 */
export const issueEnvironment = liveValue("github-issue.environment", {
  schema: IssueEnvironmentSchema,
  needsMachine: { feature: "Describing this instance in an issue" },
});
