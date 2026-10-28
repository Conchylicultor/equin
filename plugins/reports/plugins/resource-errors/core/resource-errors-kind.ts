import { z } from "zod";

/** The report kind a failing live read files. */
export const RESOURCE_ERROR_KIND = "resource-error";

// The resource-error report payload, stored in the generic `data` jsonb column
// and validated on ingest by the resource-error ReportKind. Built by the
// collector from the live-state primitive's `resourceErrorReportSink` body: one
// live read (`key`, `params`) whose query gained an error, with the typed
// `ResourceError` flattened to its kind and message.
export const ResourceErrorPayloadSchema = z.object({
  // The live-resource key whose read failed.
  key: z.string(),
  // The params of the failing tuple.
  params: z.record(z.string(), z.string()),
  // The typed failure kind. Only `loader-failed` and `not-found` are filed —
  // `client-outdated` is the Reload advice's job, `transport` a network blip.
  errorKind: z.enum(["loader-failed", "not-found"]),
  // The failure's message, as the surface shows it.
  message: z.string(),
});
export type ResourceErrorPayload = z.infer<typeof ResourceErrorPayloadSchema>;

// Fingerprint = sha256("resource-error" + key + errorKind), first 16 hex chars.
// One failing resource is one bug, whichever params tuple hit it and whatever
// its message says this time (a loader's message often carries ids or counts),
// so `params` and `message` are excluded.
export async function resourceErrorFingerprint(
  data: ResourceErrorPayload,
): Promise<string> {
  const input = `${RESOURCE_ERROR_KIND}|${data.key}|${data.errorKind}`;
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
