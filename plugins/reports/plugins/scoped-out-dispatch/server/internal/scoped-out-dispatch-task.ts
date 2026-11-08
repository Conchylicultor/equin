import type { ReportRow } from "@plugins/reports/server";
import { ScopedOutDispatchPayloadSchema } from "../../core";

// Notification re-arm window: the scope keeps dropping the plugin on every
// visit until its composition changes, so the bell resurfaces it daily rather
// than collapsing forever onto the first sighting.
export const SCOPED_OUT_DISPATCH_NOTIF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function renderScopedOutDispatchTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest, so this is a total parse; a failure is
  // a corrupted row and should surface loudly.
  const data = ScopedOutDispatchPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const rawTitle = `${noisePrefix}[scoped-out-dispatch] ${data.scope} lacks ${data.plugin} (${data.slotId})`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;

  const lines = [
    `**A dispatch slot fell back inside a scope, though the page serves its key.** ${data.message}`,
    "",
    `Inside \`<PluginScope>\` a slot sees only the scope's plugins. \`${data.plugin}\` contributes to \`${data.slotId}\` for \`${data.key}\` on this page, but the "${data.scope}" composition does not bundle it and does not negate it by name — so it is out because nothing asked for it, or because a negative's cascade took it (an importer of a negated plugin).`,
    "",
    `**Fault**`,
    `- **Scope:** \`${data.scope}\``,
    `- **Slot:** \`${data.slotId}\``,
    `- **Key:** \`${data.key}\``,
    `- **Plugin left out:** \`${data.plugin}\``,
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
    `In the "${data.scope}" row (\`plugins/plugin-meta/plugins/composition/core/config.ts\`) decide whether the scope should render \`${data.key}\` with \`${data.plugin}\`: bundle it (an entry, or narrow the negative whose cascade takes it — Studio's composition view shows the chain), or negate it by name to say the fallback is intended there. Never special-case the fallback.`,
  ];
  return { title, description: lines.join("\n") };
}
