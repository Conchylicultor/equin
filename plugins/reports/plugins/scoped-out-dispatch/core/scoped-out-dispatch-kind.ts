import { z } from "zod";

// The scoped-out-dispatch report payload, stored in the generic `data` jsonb
// column and validated on ingest by the ReportKind. Mirrors slot-render's
// `ScopedOutDispatchFault`.
export const ScopedOutDispatchPayloadSchema = z.object({
  // The dispatch slot that fell back.
  slotId: z.string(),
  // The dispatch key it fell back on (a tool name, a block type, …).
  key: z.string(),
  // The plugin on the page whose contribution matches that key.
  plugin: z.string(),
  // The scope's composition id.
  scope: z.string(),
  message: z.string(),
});
export type ScopedOutDispatchPayload = z.infer<
  typeof ScopedOutDispatchPayloadSchema
>;

// Fingerprint = sha256(scope, slot, plugin), first 16 hex. The defect is the
// plugin missing from the scope: every key it would have served (Read, Edit,
// Write…) is one report, its count growing.
export async function scopedOutDispatchFingerprint(
  data: ScopedOutDispatchPayload,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    [data.scope, data.slotId, data.plugin].join("\0"),
  );
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out.slice(0, 16);
}
