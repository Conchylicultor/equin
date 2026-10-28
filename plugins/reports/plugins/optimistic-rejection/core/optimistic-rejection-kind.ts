import { z } from "zod";

// The optimistic-rejection report payload, stored in the generic `data` jsonb
// column and validated on ingest by the optimistic-rejection ReportKind.
// Mirrors `OptimisticRejectionReport`, the neutral body the optimistic-mutation
// primitive emits into its rejection sink — this schema is the ingest-side
// contract for that same shape.
export const OptimisticRejectionPayloadSchema = z.object({
  // The live-state resource key the rejected write targeted.
  resourceKey: z.string(),
  // The resource params the write was aimed at (the page id, …), if any.
  params: z.record(z.string(), z.string()).nullable(),
  // The consumer's `label` ("what is being saved"), if it passed one.
  label: z.string().nullable(),
  // The HTTP status the server answered with.
  status: z.number().int(),
  // The server's reason (the endpoint's error body), capped by the primitive.
  message: z.string(),
  // The consumer's bounded `describeOp(vars)` (or a detached write's
  // `describe`) — never raw vars.
  opSummary: z.string().nullable(),
});
export type OptimisticRejectionPayload = z.infer<
  typeof OptimisticRejectionPayloadSchema
>;

// Rejection fingerprint = sha256(resourceKey + label + status + opSummary +
// message), first 16 hex chars. `params` is EXCLUDED: the same wrong
// prediction is rejected on every page it happens on, and those are one bug,
// not N. Ids inside `message` are normalized out for the same reason.
export async function optimisticRejectionFingerprint(
  data: OptimisticRejectionPayload,
): Promise<string> {
  const input = `${data.resourceKey}|${data.label ?? ""}|${data.status}|${data.opSummary ?? ""}|${normalizeMessage(data.message)}`;
  return sha256Hex(input).then((h) => h.slice(0, 16));
}

// Block ids, uuids and bare numbers vary per occurrence; the reason around them
// is the finding.
function normalizeMessage(message: string): string {
  return message
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/\b[a-z]+-\d{6,}-[a-z0-9]+\b/gi, "<id>")
    .replace(/\d+/g, "<n>");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
