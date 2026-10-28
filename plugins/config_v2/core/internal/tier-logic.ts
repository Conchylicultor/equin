import type { ConfigProxy } from "./config-proxy";
import { computeHash } from "./config-proxy";
import type { ConfigDescriptor, ConfigValues } from "./types";
import type { JsonValue } from "./types";
import type { FieldsRecord } from "@plugins/fields/core";
import type { ConfigV2ValidationIssue } from "./resource";

// A user override is "foreign" when it shares NO key with its descriptor's
// current field set — a leftover from a prior config SHAPE (e.g. the dead
// pre-`items` reorder `{ order, hidden }` format). Such a document can't be
// honored (none of its keys map to a field) yet schema `.passthrough()` +
// per-field default-backfill heals it to an effectively empty document, so it
// would silently WIN over the propagated origin while its `// @hash` still
// matches (it isn't hash-"stale"). For a reorder slot that means the slot drops
// its authored order. `setConfig` always writes a FULL document, so any genuine
// override carries at least one field key; only stale/foreign docs share none.
// An empty `{}` makes no claim and is not treated as foreign.
export function isForeignOverride(
  content: JsonValue | undefined,
  fieldKeys: string[],
): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content))
    return false;
  const keys = Object.keys(content as Record<string, JsonValue>);
  if (keys.length === 0) return false;
  return !keys.some((k) => fieldKeys.includes(k));
}

// The override content iff the hash chain says it should be honored — present
// and NOT stale relative to its origin. On a hash conflict the override was
// written against a now-stale origin, so the origin takes precedence until the
// user reconciles (acknowledge-conflict rewrites the hash, after which it wins
// again). With no origin to defer to, the override still stands. Returns
// undefined when there is no such override. Schema/foreign validity is a
// separate concern, layered on by the callers.
function nonStaleOverrideContent(
  originData: { content: JsonValue; hash: string | null } | null,
  overwrites: ConfigProxy,
): JsonValue | undefined {
  if (!overwrites.exists()) return undefined;
  const ow = overwrites.read();
  if (!ow) return undefined;
  const stale =
    originData !== null &&
    ow.hash !== null &&
    ow.hash !== computeHash(originData.content);
  return stale ? undefined : ow.content;
}

export function effective(
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): JsonValue | undefined {
  const originData = origin.read();
  const ow = nonStaleOverrideContent(originData, overwrites);
  if (ow !== undefined) return ow;
  if (!originData) return undefined;
  return originData.content;
}

export function hasConflict(
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): boolean {
  if (!overwrites.exists()) return false;
  const ow = overwrites.read();
  if (!ow || ow.hash === null) return false;
  const originData = origin.read();
  if (!originData) return true;
  return ow.hash !== computeHash(originData.content);
}

export function propagate(
  upstream: ConfigProxy,
  downstreamOrigin: ConfigProxy,
  downstreamOverwrites: ConfigProxy,
  ancestor?: ConfigProxy,
): { conflict: boolean } {
  const up = upstream.read();
  if (!up) return { conflict: false };
  const hash = computeHash(up.content);

  // Snapshot the merge base BEFORE overwriting the origin. The override was
  // written against the origin currently on disk; once we propagate the new
  // upstream, that ancestor content is gone (only its hash survives in the
  // override header). Capture it precisely at the transition moment — the
  // override is still in sync with the origin (`oldOrigin.hash === ow.hash`)
  // but the new upstream will make it stale (`ow.hash !== hash`) — so a later
  // three-way merge has a real base. Naturally idempotent across repeated
  // builds: once the override is stale, `oldOrigin.hash !== ow.hash`, so we
  // never clobber the true base with an intermediate origin.
  if (ancestor) {
    const oldOrigin = downstreamOrigin.read();
    const ow = downstreamOverwrites.exists()
      ? downstreamOverwrites.read()
      : null;
    if (
      ow &&
      ow.hash !== null &&
      oldOrigin &&
      oldOrigin.hash === ow.hash &&
      ow.hash !== hash
    ) {
      ancestor.write(oldOrigin.content, oldOrigin.hash);
    }
  }

  downstreamOrigin.write(up.content, hash);
  if (downstreamOverwrites.exists()) {
    const ow = downstreamOverwrites.read();
    if (ow && ow.hash !== null && ow.hash !== hash) {
      return { conflict: true };
    }
  }
  return { conflict: false };
}

// Per-field three-way merge of a config document. `base` is the origin the
// override was written against (the ancestor snapshot); `ours` is the user
// override; `theirs` is the new origin. A field only one side changed takes
// that side; a field both sides changed identically agrees; a field both sides
// changed differently is a true conflict — left as `ours` (a tentative pick)
// and reported in `conflicts` for the user to resolve. Equality is structural
// JSON equality, matching the rest of config_v2's change detection.
export function threeWayMerge(
  base: Record<string, JsonValue>,
  ours: Record<string, JsonValue>,
  theirs: Record<string, JsonValue>,
): { merged: Record<string, JsonValue>; conflicts: string[] } {
  const eq = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const merged: Record<string, JsonValue> = {};
  const conflicts: string[] = [];
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);
  for (const key of keys) {
    const b = base[key];
    const o = ours[key];
    const t = theirs[key];
    const oursChanged = !eq(o, b);
    const theirsChanged = !eq(t, b);
    if (!oursChanged) {
      merged[key] = t as JsonValue;
    } else if (!theirsChanged) {
      merged[key] = o as JsonValue;
    } else if (eq(o, t)) {
      merged[key] = o as JsonValue;
    } else {
      merged[key] = o as JsonValue;
      conflicts.push(key);
    }
  }
  return { merged, conflicts };
}

// WHICH LAYER SUPPLIED THE VALUES THE RUNTIME IS SERVING.
//
// "user" = the per-worktree override document won; "git" = the propagated origin
// (the repo's generated origin ⊕ any committed authored override) won; "default"
// = neither was usable and the code defaults stand.
//
// This is the answer the settings pane's "modified" indicator is a function of —
// modified means the USER layer supplied it — which is why the winner is named
// once here rather than re-derived from a value comparison. A comparison can't
// tell "the user changed this" from "an unusable document happens to differ":
// a foreign or schema-invalid override differs from the origin in every key
// while the runtime is ignoring it wholesale.
export type ResolvedLayer = "user" | "git" | "default";

export interface ResolvedConfig<F extends FieldsRecord> {
  layer: ResolvedLayer;
  values: ConfigValues<F>;
  // The override document as read off disk, whether or not it won. `null` when
  // there is no override file, or its hash is stale. Callers that diff the user
  // layer against the git layer need the raw document, not the resolved values.
  overrideContent: JsonValue | null;
  // The origin document as read off disk, `null` when absent.
  originContent: JsonValue | null;
}

// THE tier cascade — the one place the origin/override/defaults precedence is
// spelled out. `readTypedConfig` is this minus the provenance; `computeFieldTiers`
// (server) is this plus a per-key diff. Parses at most twice (never once per
// caller), so the hot config-read path costs exactly what it did before.
export function readTypedConfigWithLayer<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): ResolvedConfig<F> {
  const fieldKeys = Object.keys(descriptor.fields);
  const originData = origin.read();
  const originContent = originData ? originData.content : null;
  const rawOverride = overwrites.exists()
    ? (overwrites.read()?.content ?? null)
    : null;

  // Tier 1: a non-stale override wins — but only if it can actually be applied.
  const ow = nonStaleOverrideContent(originData, overwrites);
  if (ow !== undefined) {
    if (isForeignOverride(ow, fieldKeys)) {
      // A leftover from a prior config shape (no key maps to a field) can't be
      // applied. Degrade to the ORIGIN (the propagated authored default), NOT
      // the empty code defaults — for a reorder slot that keeps the authored
      // order. Surfaced as a kind:"invalid" conflict (validationIssues) so the
      // user can reset it.
      console.warn(
        `[config-v2] foreign override for "${descriptor.name}" ` +
          `(keys ${Object.keys(ow as Record<string, JsonValue>).join(", ")} match no current field); ` +
          `resolving to origin.`,
      );
    } else {
      const result = descriptor.schema.safeParse(ow);
      if (result.success) {
        return {
          layer: "user",
          values: result.data as ConfigValues<F>,
          overrideContent: rawOverride,
          originContent,
        };
      }
      console.warn(
        `[config-v2] override for "${descriptor.name}" failed validation; resolving to origin. ` +
          `Issues: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      );
    }
  }

  // Tier 2: the propagated origin (git/code authored default).
  if (originData) {
    const result = descriptor.schema.safeParse(originData.content);
    if (result.success) {
      return {
        layer: "git",
        values: result.data as ConfigValues<F>,
        overrideContent: rawOverride,
        originContent,
      };
    }
    console.warn(
      `[config-v2] origin for "${descriptor.name}" failed validation; resolving to defaults. ` +
        `Issues: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }

  // Tier 3: code defaults. An absent document is the legitimate "use defaults"
  // case (no warning above); a fall-through from an unusable tier warned already.
  return {
    layer: "default",
    values: { ...descriptor.defaults },
    overrideContent: rawOverride,
    originContent,
  };
}

export function readTypedConfig<F extends FieldsRecord>(
  descriptor: ConfigDescriptor<F>,
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): ConfigValues<F> {
  return readTypedConfigWithLayer(descriptor, origin, overwrites).values;
}

// Human-readable issues when the effective stored document cannot be applied as
// the descriptor's current schema — null when it resolves cleanly. Mirrors
// readTypedConfigWithLayer's tiering so the surfaced conflict matches what the
// runtime actually did. It re-walks the cascade rather than calling it because
// it needs the REASON each tier was rejected, not the winner; if a third reader
// ever wants both, widen ResolvedConfig with the rejection instead of adding a
// fourth copy of the precedence. A non-stale override that is FOREIGN (shares no field — a
// prior-shape leftover) or fails the schema is surfaced as invalid (the runtime
// degraded to the origin); with no usable override, an invalid ORIGIN is
// surfaced. A pure predicate the server re-runs to populate the conflicts
// resource.
export function validationIssues(
  descriptor: ConfigDescriptor,
  origin: ConfigProxy,
  overwrites: ConfigProxy,
): ConfigV2ValidationIssue[] | null {
  const fieldKeys = Object.keys(descriptor.fields);
  const originData = origin.read();
  const ow = nonStaleOverrideContent(originData, overwrites);
  if (ow !== undefined) {
    if (isForeignOverride(ow, fieldKeys)) {
      const keys = Object.keys(ow as Record<string, JsonValue>).join(", ");
      // path [] (root) — the whole document is unusable; the UI drills the
      // offending value out of overrideValues at the root.
      return [
        {
          path: [],
          message:
            `This saved setting is from an earlier version and can no longer be applied ` +
            `(unknown keys: ${keys}). Reset to defaults to restore the current layout.`,
        },
      ];
    }
    const result = descriptor.schema.safeParse(ow);
    if (result.success) return null; // override is usable
    // Keep the zod path as an array so the UI can drill the offending value out
    // of the stored document; readTypedConfig joins it inline only for its log.
    return result.error.issues.map((i) => ({
      path: i.path.map((k) => (typeof k === "symbol" ? String(k) : k)),
      message: i.message,
    }));
  }
  // No usable override → the effective value is the origin; surface only if the
  // origin itself fails the schema. An absent document is the legitimate
  // defaults case, not invalid.
  if (!originData) return null;
  const result = descriptor.schema.safeParse(originData.content);
  if (result.success) return null;
  return result.error.issues.map((i) => ({
    path: i.path.map((k) => (typeof k === "symbol" ? String(k) : k)),
    message: i.message,
  }));
}
