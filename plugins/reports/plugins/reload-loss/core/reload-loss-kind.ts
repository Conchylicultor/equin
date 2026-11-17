import { z } from "zod";

/**
 * Where a reload-loss was seen:
 * - `unmount` — the dev unmount detector (kept-state/loss-detector): a
 *   page-level place unmounted (a hidden tab unloaded by tab residency) with
 *   React state the user changed that is neither kept nor marked transient.
 */
export const RELOAD_LOSS_ORIGINS = ["unmount"] as const;

// The reload-loss report payload, stored in the generic `data` jsonb column
// and validated on ingest by the ReportKind. Mirrors loss-detector's
// `StateLoss` (the collector maps one onto the other).
export const ReloadLossPayloadSchema = z.object({
  origin: z.enum(RELOAD_LOSS_ORIGINS),
  // The keep-scope path of the place that unmounted (`t:<tabId>`).
  scope: z.string(),
  // The component holding the state, and the named components above it.
  component: z.string(),
  owners: z.array(z.string()).max(8),
  // Which useState / useReducer of the component, counting from 0.
  stateIndex: z.number().int().nonnegative(),
  // `<file>:<line>` of the first element the component renders, and the
  // `Name@<file>:<line>` owning it (element-picker's build stamps).
  source: z.string().optional(),
  uiOwner: z.string().optional(),
  // What the lost value looked like — its shape, never its content.
  value: z.string(),
});
export type ReloadLossPayload = z.infer<typeof ReloadLossPayloadSchema>;

// Fingerprint = sha256(origin, component, state index, source), first 16 hex:
// one piece of state in one component is one defect, wherever it was lost.
export async function reloadLossFingerprint(
  data: ReloadLossPayload,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    [
      data.origin,
      data.component,
      String(data.stateIndex),
      data.source ?? "",
    ].join("\0"),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out.slice(0, 16);
}
