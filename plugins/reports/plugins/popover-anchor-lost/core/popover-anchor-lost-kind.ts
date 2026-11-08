import { z } from "zod";

// What the collector knows of one element, read with ui-context's
// `collectMeta`: its description, its plugin lineage, the source line that
// rendered it and the component that owns it (the last two only when the
// source-location transform is active).
const ElementInfoSchema = z.object({
  // e.g. "button — Wish".
  element: z.string(),
  // Composition lineage outer→inner — which plugin / slot / pane it is in.
  path: z.string().optional(),
  source: z.string().optional(),
  owner: z.string().optional(),
  // A short CSS path, for finding it in the DOM.
  selector: z.string().optional(),
});

// The popover-anchor-lost report payload, stored in the generic `data` jsonb
// column and validated on ingest by the ReportKind. Mirrors
// `PopoverAnchorLostFault` (ui-kit), which carries ELEMENTS — the collector
// turns them into these descriptions, so the pair is pinned by the mapping
// rather than by `satisfies` on a shared shape.
export const PopoverAnchorLostPayloadSchema = z.object({
  // `detached`: the anchor left the document. `no-box`: it is in the document
  // but drawn as nothing (`display: none` on it or an ancestor).
  cause: z.enum(["detached", "no-box"]),
  // The popover whose anchor was lost (its positioner, which carries the
  // portal-forwarded lineage of where it was opened).
  popover: ElementInfoSchema,
  // The element the popover is anchored to: its trigger, or the caller's anchor.
  anchor: ElementInfoSchema,
  // The nearest `display: none` element up from the anchor — who hid it. Null
  // when detached, or when nothing up the chain is `display: none`.
  hiddenBy: ElementInfoSchema.nullable(),
  message: z.string(),
});
export type PopoverAnchorLostPayload = z.infer<
  typeof PopoverAnchorLostPayloadSchema
>;

// Fingerprint = sha256(cause, popover lineage, anchor, hider), first 16 hex.
// (Which popover, which anchor, why) is the defect: the Wish button hidden by
// the floating bar and a menu trigger removed by a re-keyed list are two bugs
// in two plugins. The hider is named by its source line when known (stable
// across classes and text), else by its description.
export async function popoverAnchorLostFingerprint(
  data: PopoverAnchorLostPayload,
): Promise<string> {
  const hider = data.hiddenBy
    ? (data.hiddenBy.source ?? data.hiddenBy.element)
    : "";
  return sha256Hex(
    [
      data.cause,
      data.popover.path ?? data.popover.element,
      data.anchor.source ?? data.anchor.element,
      hider,
    ].join("\0"),
  ).then((h) => h.slice(0, 16));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
