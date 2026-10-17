import { z } from "zod";

// The panel-overflow report payload, stored in the generic `data` jsonb column
// and validated on ingest by the panel-overflow ReportKind. Mirrors
// `PanelOverflowFault`, the neutral body the control-panel primitive emits into
// `panelOverflowReportSink` when a popover panel's showing page is wider than
// the panel: its content needs a width bucket nothing on the page declared.
//
// A DUPLICATE of the fault's shape rather than an import: the fault type lives
// on the primitive's WEB barrel and this file is `core`, shared with the
// server. The web collector maps one onto the other under `satisfies`, which
// pins them together at compile time.
export const PanelOverflowPayloadSchema = z.object({
  // The panel's accessible label ("View options", "Section options") — what
  // names the surface, and with `page` the defect's identity.
  label: z.string(),
  // The showing page's title (its back header), or "root".
  page: z.string(),
  // Every width need the showing page declares (`data-cp-needs`); empty means
  // the page declared nothing and was drawn menu-wide.
  needs: z.array(z.string()),
  panelWidth: z.number(),
  contentWidth: z.number(),
  // The first element reaching past the panel's edge, as a short selector.
  offender: z.string(),
  // The primitive's own sentence. Excluded from the fingerprint: it quotes
  // pixel widths, which vary with the theme and the viewport.
  message: z.string(),
});
export type PanelOverflowPayload = z.infer<typeof PanelOverflowPayloadSchema>;

// Fingerprint = sha256(label + "\0" + page), first 16 hex. The (panel, page)
// pair IS the defect: one page missing one declaration. Widths, needs and the
// offender's classes vary with the theme, the data and the viewport, so
// including them would file one defect many times.
export async function panelOverflowFingerprint(
  data: PanelOverflowPayload,
): Promise<string> {
  return sha256Hex(`${data.label}\0${data.page}`).then((h) => h.slice(0, 16));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
