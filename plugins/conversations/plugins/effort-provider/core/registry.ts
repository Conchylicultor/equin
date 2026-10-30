import { z } from "zod";
import { tolerantEnum } from "@plugins/primitives/plugins/live-state/core";

/**
 * Per-conversation "thinking mode". The five concrete levels map 1:1 to the
 * `claude --effort <level>` flag; `ultracode` is NOT a valid `--effort` value —
 * it is its own session-scoped settings key (`--settings '{"ultracode":true}'`)
 * that sends xhigh effort AND enables dynamic-workflow orchestration.
 */
export const EffortLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/** Used to normalize a corrupt stored value (absence = "no mode", handled separately). */
const FALLBACK_EFFORT: EffortLevel = "high";

export type EffortMeta = {
  label: string;
  /** Value passed to `--effort <flag>`. Absent for modes delivered via settings. */
  effortFlag?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Object merged into `--settings '<json>'`. Used by ultracode. */
  settings?: Record<string, unknown>;
};

/** THE single source of truth: id → CLI delivery + display metadata. */
export const EFFORT_REGISTRY: Record<EffortLevel, EffortMeta> = {
  low: { label: "Low", effortFlag: "low" },
  medium: { label: "Medium", effortFlag: "medium" },
  high: { label: "High", effortFlag: "high" },
  xhigh: { label: "Extra high", effortFlag: "xhigh" },
  max: { label: "Max", effortFlag: "max" },
  ultracode: { label: "Ultracode", settings: { ultracode: true } },
};

/**
 * What "no thinking mode picked" is called, everywhere it is named: the picker
 * row that clears it, and the pill that reads it back.
 *
 * It lives beside the registry because it belongs to the same question the
 * registry answers — which thinking mode is this running at? — and "none, let
 * the agent decide" is one of that question's answers, not a word each surface
 * invents for itself.
 */
export const EFFORT_UNSET_LABEL = "Auto";

/** Selectable modes, in registry order — drives every picker. */
export const SELECTABLE_EFFORTS = Object.keys(EFFORT_REGISTRY) as EffortLevel[];

/** The `--effort` flag value for a level, or `undefined` if it is delivered via settings. */
export function resolveEffortFlag(level: EffortLevel): string | undefined {
  return EFFORT_REGISTRY[level].effortFlag;
}

/** The `--settings` object for a level, or `undefined` if it is delivered via the flag. */
export function resolveEffortSettings(
  level: EffortLevel,
): Record<string, unknown> | undefined {
  return EFFORT_REGISTRY[level].settings;
}

/** Boundary guard for any *stored* effort string read back from the DB. */
export function normalizeEffort(stored: string): EffortLevel {
  return stored in EFFORT_REGISTRY ? (stored as EffortLevel) : FALLBACK_EFFORT;
}

const reportedCorrupt = new Set<string>();

/** Loud-but-deduped signal for a stored effort value that isn't a known id. */
export function reportUnknownEffort(raw: unknown): void {
  const s = String(raw);
  if (Object.hasOwn(EFFORT_REGISTRY, s) || reportedCorrupt.has(s)) return;
  reportedCorrupt.add(s);
  console.error(
    `[effort] corrupt/unknown stored effort ${JSON.stringify(raw)} — degraded to ${FALLBACK_EFFORT}. Indicates a corrupt DB row or a writer on incompatible code.`,
  );
}

/**
 * THE schema for a *persisted* effort value surfaced through a live-state resource.
 * Tolerant by construction so a corrupt row normalizes (and reports) instead of
 * rejecting the whole array payload on the WS push path. Keep request-input/API-body
 * schemas strict (use the raw EffortLevelSchema there).
 */
export const StoredEffortSchema = tolerantEnum(EffortLevelSchema, {
  fallback: FALLBACK_EFFORT,
  onFallback: reportUnknownEffort,
});
