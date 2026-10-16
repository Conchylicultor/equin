import type { ConfigProxy } from "./config-proxy";
import { effective } from "./tier-logic";
import type { JsonValue } from "./types";

/**
 * One descriptor's COMMITTED config, resolved — what a fresh user's origin
 * layer holds after `./singularity build` propagates the repo's `config/`:
 *
 * - `base`: the git-effective document (`override ⊕ origin`, a stale override
 *   losing to its origin — `effective`);
 * - `scopes`: app id → that `@app/<id>` scope's document, the base-anchored
 *   delta resolved over `base` (`{ ...base, ...delta }`).
 */
export interface GitLayerDocument {
  base: JsonValue;
  scopes: Record<string, JsonValue>;
}

function asRecord(v: JsonValue | undefined): Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : {};
}

/**
 * THE git-layer rule, spelled once: the build's propagation into a user layer
 * (`propagateConfigToUser`) and the git layer bundled for the browser server
 * both resolve through it, so the two cannot disagree. `undefined` when the
 * git layer has no document at all (no origin, no override). A scope whose
 * delta file is absent is omitted.
 */
export function resolveGitLayer(
  origin: ConfigProxy,
  override: ConfigProxy,
  scopedDeltas: ReadonlyMap<string, ConfigProxy>,
): GitLayerDocument | undefined {
  const base = effective(origin, override);
  if (base === undefined) return undefined;
  const baseRecord = asRecord(base);
  const scopes: Record<string, JsonValue> = {};
  for (const [appId, delta] of scopedDeltas) {
    const read = delta.read();
    if (!read) continue;
    scopes[appId] = { ...baseRecord, ...asRecord(read.content) };
  }
  return { base, scopes };
}
