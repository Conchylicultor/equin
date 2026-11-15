import { z } from "zod";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it and the scan command (`cli/`) files under it through the outbox.
 */
export const BLOCKED_ARTIFACT_URL_KIND = "blocked-artifact-url";

/**
 * One served URL a default content-blocker rule cancels: the file it comes
 * from, the rule, and how many served URLs of that file the rule matched.
 */
export const BlockedArtifactUrlPayloadSchema = z.object({
  /** One served path the rule matches, e.g. `/artifacts/<entry>/core/x.js`. */
  url: z.string(),
  /**
   * The repo file it is built from, when the path names a plugin's own
   * module (a route chunk, a vendor file or a dist asset names none).
   */
  source: z.string().nullable(),
  /** The ruleset (EasyPrivacy's `easyprivacy`, …) and the rule's id in it. */
  ruleset: z.string(),
  ruleId: z.number().int(),
  /** The rule's filter as the list writes it (`/fingerprint.js^`). */
  filter: z.string(),
  /** How many served URLs of this source (or path) the rule matched in this scan. */
  matchedUrls: z.number().int().positive(),
  /** The blocker release the rules come from (`uBlock Origin Lite 2026.1110.1816`). */
  rulesFrom: z.string(),
});
export type BlockedArtifactUrlPayload = z.infer<
  typeof BlockedArtifactUrlPayloadSchema
>;

/**
 * One row per (file, rule): a rebuild changes every content hash in the URL,
 * so the URL itself would open a new row each build. A path with no source
 * is keyed with its hashes taken out.
 */
export function blockedArtifactUrlFingerprint(
  d: BlockedArtifactUrlPayload,
): string {
  const subject = d.source ?? stableServedPath(d.url);
  return `${BLOCKED_ARTIFACT_URL_KIND}:${subject}:${d.ruleset}:${d.ruleId}`;
}

/** A served path with its 16-hex content hashes replaced, so it names the same thing across builds. */
export function stableServedPath(url: string): string {
  return url.replace(/\.[0-9a-f]{16}(?=[./]|$)/g, ".<hash>");
}

/** The one-line summary: the report row's `message` and the scan's own log line. */
export function blockedArtifactUrlMessage(
  d: BlockedArtifactUrlPayload,
): string {
  return (
    `${d.source ?? d.url} is served at a URL the default ${d.ruleset} rule ${d.filter} (#${d.ruleId}) blocks — ` +
    `browsers running it (uBlock Origin, AdGuard, Brave Shields) never load it (${d.matchedUrls} served URL(s))`
  );
}
