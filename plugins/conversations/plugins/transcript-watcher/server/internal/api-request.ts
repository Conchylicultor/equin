import type { RequestConfig } from "../../core";

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * The reader-facing settings of one `type: "api-request"` line, or null when
 * the line does not carry the shape this reads (no `params.model`) — the caller
 * then lets it fall through to `kind: "unknown"`, so a format change shows up
 * as an investigate-able row rather than as nothing.
 */
export function requestConfigOf(
  obj: Record<string, unknown>,
): RequestConfig | null {
  const params = rec(obj.params);
  const model = str(params?.model);
  if (!params || !model) return null;
  const betas = Array.isArray(params.betas)
    ? params.betas.filter((b): b is string => typeof b === "string")
    : [];
  const safeguards = Array.isArray(params.safeguards) ? params.safeguards : [];
  const permissionMode = safeguards
    .map((s) => str(rec(rec(s)?.classifier_context)?.permission_mode))
    .find((m) => m !== undefined);
  const maxTokens = params.max_tokens;
  return {
    model,
    effort: str(rec(params.output_config)?.effort),
    thinking: str(rec(params.thinking)?.type),
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
    permissionMode,
    betas,
    shapeHash: str(obj.shapeHash),
  };
}
