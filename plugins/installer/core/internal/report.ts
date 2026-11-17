import { buildIssueUrl } from "@plugins/integrations/plugins/github-issues/core";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";

/**
 * Home folders in a line, as `~`: `/Users/<name>/…` (macOS) and
 * `/home/<name>/…` (Linux) — what keeps a person's account name out of a
 * report. install.sh already writes its evidence with `$HOME` as `~` and the
 * account and machine names removed; this is the second pass over whatever
 * reaches a report link, so a line the script did not write (a tool's output)
 * is covered too.
 */
export function redactPaths(line: string): string {
  return line.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~");
}

/** What a report of a pause carries. */
export interface InstallReport {
  /** The pause's title and message (the installer message rules). */
  title: string;
  text: string;
  /** The raw lines that show it. */
  evidence: readonly string[];
  /** The release installed, or null for main's tip / a checkout. */
  release: string | null;
  /** `<os>-<arch>`, from the plan. */
  platform: string;
}

/**
 * The GitHub new-issue link for a pause, labelled `install`: what happened in
 * words, the evidence (paths redacted), the release and the system, and where
 * the full log is to attach by hand. Built by the page; nothing is sent until
 * the person submits the issue on GitHub. Held under GitHub's link limit by
 * `buildIssueUrl`, which cuts the text (evidence included) before the notes.
 */
export function installIssueUrl(report: InstallReport): string {
  const evidence = report.evidence.map(redactPaths);
  const text = [
    `Install: ${report.title}`,
    "",
    redactPaths(report.text),
    ...(evidence.length > 0 ? ["", "```", ...evidence, "```"] : []),
  ].join("\n");
  return buildIssueUrl({
    repoUrl: SOURCE_REPO_URL,
    text,
    notes: [
      `Release: ${report.release ?? "main's newest version"} · system: ${report.platform}`,
      "The full log is install.log, in the newest folder of equin's install logs (the installer names it): drag it here to attach it.",
    ],
    labels: ["install"],
  });
}
