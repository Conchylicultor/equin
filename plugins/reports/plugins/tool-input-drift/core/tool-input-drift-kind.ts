import { z } from "zod";

// The tool-input-drift report payload, stored in the generic `data` jsonb
// column and validated on ingest by the ReportKind. Mirrors tool-call's
// `ToolInputDrift`.
export const ToolInputDriftPayloadSchema = z.object({
  // The tool's name as the model called it.
  tool: z.string(),
  // The call that showed it (the latest seen).
  toolUseId: z.string(),
  // What the renderer's schema rejected, one `path: message` per line.
  issues: z.string(),
  message: z.string(),
});
export type ToolInputDriftPayload = z.infer<typeof ToolInputDriftPayloadSchema>;

// Fingerprint = sha256(tool, issues), first 16 hex: one report per tool and
// way its schema disagrees, its count growing with every call that shows it.
export async function toolInputDriftFingerprint(
  data: ToolInputDriftPayload,
): Promise<string> {
  const bytes = new TextEncoder().encode([data.tool, data.issues].join("\0"));
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out.slice(0, 16);
}
