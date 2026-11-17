import type { ReportRow } from "@plugins/reports/server";
import { ReloadLossPayloadSchema } from "../../core";

// The same state is lost on every unload of its tab: re-arm the bell daily,
// not every 10 minutes.
export const RELOAD_LOSS_NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function renderReloadLossTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest: a failure here is a corrupted row.
  const data = ReloadLossPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const where = data.source ?? data.uiOwner ?? data.owners.join(" › ");
  const rawTitle = `${noisePrefix}[reload-loss] ${data.component} loses state #${data.stateIndex} on a remount`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;
  const lines = [
    `**React state the user changed was thrown away by a remount.** The dev unmount detector (\`primitives/kept-state/plugins/loss-detector\`) saw \`${data.component}\` unmount with its useState / useReducer #${data.stateIndex} (counting from 0, in call order) holding a value the user set — ${data.value} — that is neither kept (\`useKept\` / \`useDraft\`) nor marked \`useTransient("<why>")\`. A hidden tab unloaded by tab residency, a reload and an upgrade all remount, so the user loses it on each.`,
    "",
    `**State**`,
    `- **Component:** \`${data.component}\``,
    ...(data.owners.length > 0
      ? [`- **Under:** ${data.owners.map((o) => `\`${o}\``).join(" › ")}`]
      : []),
    `- **Which:** useState / useReducer #${data.stateIndex}`,
    `- **Value when lost:** ${data.value}`,
    ...(data.source
      ? [`- **First element it renders:** \`${data.source}\``]
      : []),
    ...(data.uiOwner ? [`- **Owner stamp:** \`${data.uiOwner}\``] : []),
    `- **Place:** \`${data.scope}\``,
    `- **Where to look:** ${where ? `\`${where}\`` : "the component above"}`,
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
    `Classify the state (\`primitives/kept-state/CLAUDE.md\`, "Classify a piece of state"). Work the user made → \`useKept\` work tier with a \`subject\`; where the user was looking (expanded, sub-tab, selection, query) → \`useKept\` view tier; throwaway by design (hover, busy, a menu's open flag) → \`useTransient("<why>")\`. Never mark state the user would miss as transient to silence this.`,
  ];
  return { title, description: lines.join("\n") };
}
