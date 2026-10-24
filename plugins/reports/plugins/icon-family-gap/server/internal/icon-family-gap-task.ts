import type { ReportRow } from "@plugins/reports/server";
import { IconFamilyGapPayloadSchema } from "../../core";

// Notification re-arm window: the gap shows on every load until the glyph is
// drawn, so the bell resurfaces it every 6h rather than collapsing onto the
// first sighting. Same policy as panel-overflow.
export const ICON_FAMILY_GAP_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function renderIconFamilyGapTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest, so this is a total parse; a failure is
  // a corrupted row and should surface loudly.
  const data = IconFamilyGapPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const rawTitle = `${noisePrefix}[icon-family-gap] icon family "${data.family}" has no glyph for "${data.name}"`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;
  const lines = [
    `**The icon family \`${data.family}\` is strict, and draws no glyph for the Material symbol \`${data.name}\`.** A scope whose \`iconFamily\` is \`${data.family}\` drew \`symbol("${data.name}")\`, so it shows the family's gap glyph (a dashed rounded square) instead of an icon. A strict family never borrows another family's drawing.`,
    "",
    `**How to fix**`,
    `Add a glyph for it to the family's \`defineIconFamily\` (its \`glyphs\`), and map \`${data.name}\` to it in \`symbols\`. Debug → Icons lists every name the family does not draw yet. If the family cannot cover everything yet, set it back to \`coverage: "fallback"\` with a \`fallback\` family.`,
    "",
    `**Report**`,
    `- **Source:** ${row.source}`,
    `- **Worktree:** ${row.worktree}`,
    `- **Fingerprint:** ${row.fingerprint}`,
    `- **Count:** ${row.count}`,
    `- **First seen:** ${row.firstSeenAt.toISOString()}`,
    `- **Last seen:** ${row.lastSeenAt.toISOString()}`,
    ...(row.url ? [`- **URL:** ${row.url}`] : []),
  ];
  return { title, description: lines.join("\n") };
}
