import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  BLOCKED_ARTIFACT_URL_KIND,
  BlockedArtifactUrlPayloadSchema,
  blockedArtifactUrlFingerprint,
  blockedArtifactUrlMessage,
} from "../../core";

// The scan runs daily; a hit stays until the file is renamed, so one ring a day.
const NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The `blocked-artifact-url` report kind — see the plugin's CLAUDE.md. */
export const blockedArtifactUrlKind = ReportKind({
  kind: BLOCKED_ARTIFACT_URL_KIND,
  schema: BlockedArtifactUrlPayloadSchema,
  fingerprint: blockedArtifactUrlFingerprint,
  meta: {
    tag: "[blocker-scan]",
    notif: "A served file is blocked by a default content-blocker rule",
    variant: "error",
    category: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) => {
    const d = BlockedArtifactUrlPayloadSchema.parse(row.data);
    return {
      title: `Served file blocked by ${d.ruleset}: ${d.source ?? d.url}`,
      description: [
        blockedArtifactUrlMessage(d),
        "",
        `- Served URL (one of ${d.matchedUrls}): \`${d.url}\``,
        `- Source: ${d.source === null ? "none (a route chunk, vendor file or dist asset)" : `\`${d.source}\``}`,
        `- Rule: \`${d.filter}\` (${d.ruleset} #${d.ruleId}), from ${d.rulesFrom}`,
        "",
        "Browsers running EasyList / EasyPrivacy / uBlock filters (uBlock Origin and uBO Lite, AdGuard, Brave Shields) cancel this request, so whatever imports the module fails to load for those visitors — while curl, headless Chromium and the e2e runs load it fine. A served URL is spelled from the source file's and its plugin's names, so the fix is a name the rule does not match: rename the file (or the plugin), never an exception list.",
        "Re-check with `./equin web-artifacts-blocker-scan --dry-run` after the build that renames it.",
      ].join("\n"),
    };
  },
});
