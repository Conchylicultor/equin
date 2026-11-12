import { z } from "zod";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

// The icon-missing-glyph report payload, stored in the generic `data` jsonb
// column and validated on ingest by the icon-missing-glyph ReportKind. Mirrors
// `IconMissingGlyph`, the neutral body `<Icon>` emits into
// `iconMissingGlyphReportSink` when a held sprite has no symbol for an icon it
// draws (the build's icon manifest missed the name).
//
// A DUPLICATE of its shape rather than an import: that type lives on the icons
// WEB barrel and this file is `core`, shared with the server. The web
// collector maps one onto the other under `satisfies`.
export const IconMissingGlyphPayloadSchema = z.object({
  // The held sprite's key (a style key, `brands`, `seti`, `lucide`, …).
  sprite: z.string(),
  // The `<symbol id>` it lacks.
  id: z.string(),
});
export type IconMissingGlyphPayload = z.infer<
  typeof IconMissingGlyphPayloadSchema
>;

// Fingerprint = sha256(sprite + "\0" + id), first 16 hex: one symbol one
// sprite lacks is the defect, however many icons or pages draw it.
export function iconMissingGlyphFingerprint(
  data: IconMissingGlyphPayload,
): string {
  return sha256Hex(`${data.sprite}\0${data.id}`).slice(0, 16);
}
