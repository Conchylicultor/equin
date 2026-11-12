import type { ReportRow } from "@plugins/reports/server";
import { ToolInputDriftPayloadSchema } from "../../core";

// Notification re-arm window: every transcript holding such a call shows it
// again, so the bell resurfaces it daily rather than on every view.
export const TOOL_INPUT_DRIFT_NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function renderToolInputDriftTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest, so this is a total parse; a failure is
  // a corrupted row and should surface loudly.
  const data = ToolInputDriftPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const rawTitle = `${noisePrefix}[tool-input-drift] ${data.tool}'s card rejects an input the tool took`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;

  const lines = [
    `**A tool took an input its transcript card's schema rejects.** The card fell back to the generic one.`,
    "",
    "```",
    data.issues,
    "```",
    "",
    `**Fault**`,
    `- **Tool:** \`${data.tool}\``,
    `- **Call:** \`${data.toolUseId}\``,
    "",
    `**Report**`,
    `- **Source:** ${row.source}`,
    `- **Worktree:** ${row.worktree}`,
    `- **Fingerprint:** ${row.fingerprint}`,
    `- **Count:** ${row.count}`,
    `- **First seen:** ${row.firstSeenAt.toISOString()}`,
    `- **Last seen:** ${row.lastSeenAt.toISOString()}`,
    ...(row.url ? [`- **URL:** ${row.url}`] : []),
    "",
    `**How to fix**`,
    `Find the \`JsonlViewerTool.Renderer\` matching \`${data.tool}\` (tool-call's sub-plugins) and bring its \`input\` schema in line with what the tool really takes (its MCP \`inputSchema\`, or the built-in's input) — including inputs an older version of the tool took, which transcripts keep. Never loosen it past what the card can draw.`,
  ];
  return { title, description: lines.join("\n") };
}
