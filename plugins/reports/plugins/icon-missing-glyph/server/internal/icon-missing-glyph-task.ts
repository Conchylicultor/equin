import type { ReportRow } from "@plugins/reports/server";
import { IconMissingGlyphPayloadSchema } from "../../core";

// Notification re-arm window: the glyph is missing on every load until the
// manifest is fixed and deployed, so the bell resurfaces it every 6h rather
// than collapsing onto the first sighting. Same policy as icon-family-gap.
export const ICON_MISSING_GLYPH_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function renderIconMissingGlyphTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at ingest, so this is a total parse; a failure is
  // a corrupted row and should surface loudly.
  const data = IconMissingGlyphPayloadSchema.parse(row.data);
  const noisePrefix = row.noise ? "[noise] " : "";
  const rawTitle = `${noisePrefix}[icon-missing-glyph] sprite "${data.sprite}" has no symbol "${data.id}"`;
  const title =
    rawTitle.length > 120 ? `${rawTitle.slice(0, 117)}...` : rawTitle;
  const lines = [
    `**The \`${data.sprite}\` sprite has no \`<symbol id="${data.id}">\`, but an \`<Icon>\` drew it.** The icon shows the missing-glyph marker (a crossed-out dashed square). The sprites ship exactly the build's icon manifest (\`plugins/ui/plugins/icons/plugins/sprites/machine/internal/icon-manifest.generated.ts\`), so the manifest did not list a name the code draws.`,
    "",
    `**How to fix**`,
    `Run \`./equin check icons:manifest-covers-uses\` on the deployed commit: it reads every icon use through ESLint's scope analysis, independently of the manifest generator, and names the call the manifest missed. If it passes, the deploy ran an older manifest than its code (a stale build); if it fails after \`./equin build\`, the manifest scan (\`codegen/core/icon-manifest.scan.ts\`) misreads that call — fix the scan.`,
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
