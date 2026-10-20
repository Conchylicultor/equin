import type { RequestConfig, RequestShape } from "../../core";

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

/**
 * The reader-facing shape of one `type: "api-request-shape"` line — its tool
 * names and system-prompt text — or null when the line does not carry the
 * shape this reads (`shape.tools` / `shape.system` not arrays), so a format
 * change falls through to `kind: "unknown"` like `requestConfigOf`'s.
 */
export function requestShapeOf(
  obj: Record<string, unknown>,
): RequestShape | null {
  const shape = rec(obj.shape);
  if (!shape || !Array.isArray(shape.tools) || !Array.isArray(shape.system)) {
    return null;
  }
  return {
    tools: shape.tools
      .map((t) => str(rec(t)?.name))
      .filter((n): n is string => n !== undefined),
    system: shape.system
      .map((b) => str(rec(b)?.text))
      .filter((t): t is string => t !== undefined),
  };
}
