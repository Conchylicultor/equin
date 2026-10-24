import { z } from "zod";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

// The icon-family-gap report payload, stored in the generic `data` jsonb column
// and validated on ingest by the icon-family-gap ReportKind. Mirrors
// `IconFamilyGap`, the neutral body `<Icon>` emits into
// `iconFamilyGapReportSink` when a scope whose icon family is strict draws a
// symbol the family does not map.
//
// A DUPLICATE of the gap's shape rather than an import: the gap type lives on
// the icons WEB barrel and this file is `core`, shared with the server. The web
// collector maps one onto the other under `satisfies`.
export const IconFamilyGapPayloadSchema = z.object({
  // The strict family's id (an `iconFamily` token value).
  family: z.string(),
  // The Material symbol name it does not draw.
  name: z.string(),
});
export type IconFamilyGapPayload = z.infer<typeof IconFamilyGapPayloadSchema>;

// Fingerprint = sha256(family + "\0" + name), first 16 hex: the (family, name)
// pair IS the defect — one glyph the family still has to draw — however many
// icons, scopes or pages show it.
export function iconFamilyGapFingerprint(data: IconFamilyGapPayload): string {
  return sha256Hex(`${data.family}\0${data.name}`).slice(0, 16);
}
