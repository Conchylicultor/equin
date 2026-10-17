import type { ReportRow } from "@plugins/reports/server";
import { PanelOverflowPayloadSchema } from "../../core";

// Notification re-arm window: the missing declaration reproduces the overflow
// every time the page opens, so the bell resurfaces it every 6h rather than
// collapsing onto the first sighting. Same policy as viewport-escape.
export const PANEL_OVERFLOW_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function renderPanelOverflowTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest, so this is a total parse; a failure is
  // a corrupted row and should surface loudly.
  const data = PanelOverflowPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const rawTitle = `${noisePrefix}[panel-overflow] ${data.label} / ${data.page} — content wider than the panel`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;

  const declared =
    data.needs.length > 0
      ? data.needs.map((n) => `\`${n}\``).join(", ")
      : "none (drawn menu-wide)";
  const lines = [
    `**The page "${data.page}" of the control panel "${data.label}" is wider than the panel.** A popover panel's width is the bucket its showing page's CONTENT declares (\`data-cp-needs\`: \`described\` < \`picker\` < \`builder\`, sized by the theme), and something on this page needs more than it declared — so it spills past the panel's edge.`,
    "",
    `**The guard's own words**`,
    `> ${data.message}`,
    "",
    `**Fault**`,
    `- **Panel width:** ${Math.round(data.panelWidth)}px`,
    `- **Content width:** ${Math.round(data.contentWidth)}px`,
    `- **Declared needs on the page:** ${declared}`,
    `- **First element past the edge:** \`${data.offender}\``,
    "",
    `**Report**`,
    `- **Source:** ${row.source}`,
    `- **Worktree:** ${row.worktree}`,
    `- **Fingerprint:** ${row.fingerprint}`,
    `- **Count:** ${row.count}`,
    `- **First seen:** ${row.firstSeenAt.toISOString()}`,
    `- **Last seen:** ${row.lastSeenAt.toISOString()}`,
    ...(row.url ? [`- **URL:** ${row.url}`] : []),
    ...(row.userAgent ? [`- **User-Agent:** ${row.userAgent}`] : []),
    "",
    `**How to fix**`,
    `Find the content that reaches past the edge and declare the width it needs where it is rendered — never where the panel is opened. A grid (icons, emoji, swatches, a calendar) goes in \`<ControlPanel.Section needs="picker">\`; a builder page with no rule row yet takes \`needs="builder"\` (\`RuleRow\` and a \`Row\` with a \`description\` state theirs themselves). If the content is genuinely wider than every bucket, it is the content that must give (truncate, wrap, or use a member that does) — see the control-panel CLAUDE.md, "The content declares its width".`,
  ];
  return { title, description: lines.join("\n") };
}
