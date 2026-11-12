import {
  fenceUntrustedReport,
  isUntrustedReportSource,
  type Report,
} from "@plugins/reports/core";

/**
 * The first turn of an agent launched on one report: its kind and source, its
 * content (message and payload), and the user's own extra context. Content
 * from an untrusted source (a website visitor's error — strangers wrote it) is
 * fenced as data, never instructions; the user's context is theirs and stays
 * outside the fence.
 */
export function investigationPrompt(
  report: Pick<Report, "kind" | "source" | "message" | "data">,
  userText: string,
): string {
  const parts: string[] = [];
  parts.push(`## Report (${report.kind})\n`);
  parts.push(`**Source:** ${report.source}`);
  const content = [
    `**Message:** ${report.message}`,
    `\n\`\`\`json\n${JSON.stringify(report.data, null, 2)}\n\`\`\``,
  ].join("\n");
  parts.push(
    isUntrustedReportSource(report.source)
      ? fenceUntrustedReport(content)
      : content,
  );
  const extra = userText.trim();
  if (extra) {
    parts.push(`\n## Context\n\n${extra}`);
  }
  return parts.join("\n");
}
