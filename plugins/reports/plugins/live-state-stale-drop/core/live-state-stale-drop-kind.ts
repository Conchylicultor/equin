import { z } from "zod";

// The live-state-stale-drop report payload, stored in the generic `data` jsonb
// column and validated on ingest by the live-state-stale-drop ReportKind.
// Mirrors `HttpStaleDropReport`, the neutral body the live-state primitive emits
// into `httpStaleDropReportSink` when `fetchOverHttp` drops an HTTP body its
// version/epoch guard judged stale — this schema is the ingest-side contract for
// that same shape. The primitive is policy-free (it emits every drop with a
// running count); the collector owns the wedge threshold.
export const LiveStateStaleDropPayloadSchema = z.object({
  // The live-state resource key whose HTTP body was dropped.
  key: z.string(),
  // The resource params the dropped fetch was for.
  params: z.record(z.string(), z.string()),
  // Why the body was dropped: `stale-version` = same-boot strict-`<` guard
  // (body.version < entry.version); `stale-epoch` = the body's boot epoch is the
  // stale one (case 3 of the cross-boot guard matrix).
  reason: z.enum(["stale-version", "stale-epoch"]),
  // Consecutive drops for this key since the last successful apply. Volatile —
  // deliberately excluded from the fingerprint.
  consecutiveDrops: z.number(),
  // The dropped body's server version and the version the client already held.
  bodyVersion: z.number(),
  haveVersion: z.number(),
  // The boot epochs in play: the body's, the client entry's, and the WS
  // channel's current server identity. Any may be null (epoch-less pre-upgrade
  // body, or an entry that never adopted a versioned frame).
  bodyEpoch: z.string().nullable(),
  entryEpoch: z.string().nullable(),
  serverEpoch: z.string().nullable(),
  // Which fetch path dropped the body: `prime` (best-effort sub-ack prime) or
  // `fallback` (the WS-down HTTP fallback refetch).
  source: z.enum(["prime", "fallback"]),
  // The wedge discriminator: true when the query has never settled on a
  // server-vouched value (`dataUpdatedAt` still at epoch 0). A
  // never-applied drop is the "Close (state unknown)" wedge; an applied one is a
  // benign transient (the cache already holds newer truth).
  neverApplied: z.boolean(),
});
export type LiveStateStaleDropPayload = z.infer<
  typeof LiveStateStaleDropPayloadSchema
>;

// Stale-drop fingerprint = sha256("live-state-stale-drop" + key + reason), first
// 16 hex chars. `key` + `reason` alone: one wedged resource is one bug. The
// volatile fields — `params`, `consecutiveDrops`, `bodyVersion`/`haveVersion`,
// the epochs, `source`, `neverApplied` — are ALL excluded: they change between
// otherwise-identical repeats of the same wedge (every param combination, every
// boot, every retry), and including any of them would split one bug across many
// `_reports` rows. One wedge = one bug = one row.
export async function liveStateStaleDropFingerprint(
  data: LiveStateStaleDropPayload,
): Promise<string> {
  const input = `live-state-stale-drop|${data.key}|${data.reason}`;
  return sha256Hex(input).then((h) => h.slice(0, 16));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
