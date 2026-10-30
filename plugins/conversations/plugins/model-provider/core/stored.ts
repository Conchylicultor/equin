import { tolerantEnum } from "@plugins/primitives/plugins/live-state/core";
import { FALLBACK_MODEL } from "./catalog";
import {
  ConversationModelSchema,
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
  type ConversationModel,
  type ModelChoice,
} from "./registry";

// Stored values are checked against the id GRAMMAR, never the catalog: a
// well-formed id this machine's catalog has not seen (a row written by a newer
// checkout, a retired version) is still valid and labels itself from the id.
// Only a MALFORMED value is corruption — "unknown" and "corrupt" are different
// things, and only the second is reported.

/** Distinct raw values already reported this session — dedupe so a corrupt row
 *  pushed repeatedly over the WS doesn't spam the crash pipeline. */
const reportedCorruptModels = new Set<string>();

/** Injectable sink for corruption signals. Defaults to console.error so the signal
 *  is never silent even before a richer reporter is registered (e.g. server-side,
 *  or on the client before app startup wiring runs). The web runtime swaps this for
 *  a real crash report via registerModelCorruptionReporter(). */
let corruptionSink: (message: string, raw: unknown) => void = (message) =>
  console.error(message);

/** Install the sink that receives malformed stored-model signals. Called once
 *  at web app startup to route corruption into the visible crash-report pipeline.
 *  Core stays zero-dep/environment-agnostic — the web runtime injects the reporter. */
export function registerModelCorruptionReporter(
  fn: (message: string, raw: unknown) => void,
): void {
  corruptionSink = fn;
}

/** Loud signal for a stored model value that is not even a well-formed id — i.e.
 *  corruption or a writer on incompatible code. The caller degrades to the default,
 *  but never silently: the bad value reaches the injected sink. Deduped per distinct
 *  raw value for the session. */
function reportMalformedModel(raw: unknown, degradedTo: string): void {
  const s = String(raw);
  if (reportedCorruptModels.has(s)) return; // already surfaced this distinct value
  reportedCorruptModels.add(s);
  corruptionSink(
    `[model] corrupt stored model ${JSON.stringify(raw)} — not a model id, degraded to ${degradedTo}. Indicates a corrupt DB row or a writer on incompatible code.`,
    raw,
  );
}

/**
 * Boundary guard for a stored *concrete* model (what a conversation ran) read
 * back from the DB. A well-formed id passes as is, known to the catalog or
 * not; a malformed one degrades to {@link FALLBACK_MODEL} and is reported.
 */
export function normalizeModel(stored: string): ConversationModel {
  const parsed = ConversationModelSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  reportMalformedModel(stored, FALLBACK_MODEL);
  return FALLBACK_MODEL;
}

/** Boundary guard for a stored *choice* (a saved preference). A malformed value degrades to the default choice, and is reported. */
export function normalizeModelChoice(stored: string): ModelChoice {
  const parsed = ModelChoiceSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  reportMalformedModel(stored, DEFAULT_MODEL_CHOICE);
  return DEFAULT_MODEL_CHOICE;
}

/**
 * THE schema for a persisted *concrete* model (conversation `model`, claude-cli
 * call `model`). Tolerant by construction: a malformed stored value normalizes
 * (and reports) instead of rejecting the whole array payload on the WS push
 * path — which would blank the entire resource. Request-input schemas (API
 * bodies) stay strict so bad input is rejected loudly.
 */
export const StoredModelSchema = tolerantEnum(ConversationModelSchema, {
  fallback: FALLBACK_MODEL,
  onFallback: (raw) => reportMalformedModel(raw, FALLBACK_MODEL),
});

/** The tolerant schema for a persisted *choice* (auto-start marker, agent, launch prompt). */
export const StoredModelChoiceSchema = tolerantEnum(ModelChoiceSchema, {
  fallback: DEFAULT_MODEL_CHOICE,
  onFallback: (raw) => reportMalformedModel(raw, DEFAULT_MODEL_CHOICE),
});
