import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import {
  ConversationModelSchema,
  DEFAULT_MODEL_CHOICE,
  SELECTABLE_FAMILIES,
  MODEL_TIERS,
  compareModelsNewestFirst,
  choiceLabel,
  isModelFamily,
  isPrintOnlyFamily,
  modelMeta,
  type ConversationModel,
  type ModelChoice,
  type ModelTier,
} from "./registry";

// The model catalog: which versions this machine knows, which one each family
// runs today, and which are retired. Families and the id grammar are code
// (`registry.ts`); this is DATA — discovered at runtime from the Claude CLI's
// own model menu (`model-provider/catalog`), so a new release needs no code
// change. Every reader below takes the catalog as an explicit argument: the
// server passes `getModelCatalog()`, the browser `useModelCatalog()`.

export const ModelVersionSchema = z.object({
  id: ConversationModelSchema,
  /** ISO instant this machine first learned of the version. */
  firstSeenAt: z.string(),
  /** `baseline`: shipped in code as the floor; `cli`: first seen in the Claude CLI's model menu. */
  source: z.enum(["baseline", "cli"]),
  /** ISO instant discovery found it gone from the Claude CLI's model menu. Absent while the CLI offers it. */
  retiredAt: z.string().optional(),
  retiredReason: z.string().optional(),
});
export type ModelVersion = z.infer<typeof ModelVersionSchema>;

export const ModelCatalogSchema = z.object({
  versions: wholeList(ModelVersionSchema, {
    reason:
      "every Claude model version this machine has seen — a few dozen, one per release",
  }),
  /** Each family's current version: what a family choice ("Sonnet") runs. */
  current: z.object(
    Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, ConversationModelSchema]),
    ) as Record<ModelTier, typeof ConversationModelSchema>,
  ),
  /** ISO instant of the last discovery that read the CLI's model menu; null = never probed (baseline). */
  probedAt: z.string().nullable(),
  /** The Claude CLI version whose menu discovery read; null = never probed. */
  cliVersion: z.string().nullable(),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

const BASELINE_SEEN_AT = "2026-10-01T00:00:00.000Z";

function baselineVersion(raw: string): ModelVersion {
  return {
    id: ConversationModelSchema.parse(raw),
    firstSeenAt: BASELINE_SEEN_AT,
    source: "baseline",
  };
}

/**
 * The floor: the catalog of a machine that has never probed, or has no Claude
 * CLI. The same idea as cost's vendored LiteLLM snapshot — and like it, never
 * edited for a release: discovery appends what is new.
 */
export const BASELINE_MODELS: ModelCatalog = {
  versions: [
    "fable-5-1",
    "fable-5",
    "opus-5-5",
    "opus-5",
    "opus-4-8",
    "opus-4-7",
    "opus-4-6",
    "sonnet-5-5",
    "sonnet-5",
    "sonnet-4-6",
    "haiku-4-5",
  ].map(baselineVersion),
  current: {
    fable: ConversationModelSchema.parse("fable-5-1"),
    opus: ConversationModelSchema.parse("opus-5-5"),
    sonnet: ConversationModelSchema.parse("sonnet-5-5"),
    haiku: ConversationModelSchema.parse("haiku-4-5"),
  },
  probedAt: null,
  cliVersion: null,
};

/**
 * The version a malformed stored model degrades to, and the never-firing
 * wire/backfill default of a `model` column: the baseline's current version
 * of the default family. A constant on purpose — a schema default cannot read
 * the live catalog, and it never decides what an agent runs.
 */
export const FALLBACK_MODEL: ConversationModel =
  BASELINE_MODELS.current[DEFAULT_MODEL_CHOICE];

function versionOf(
  id: ConversationModel,
  catalog: ModelCatalog,
): ModelVersion | undefined {
  return catalog.versions.find((v) => v.id === id);
}

export function isRetired(
  id: ConversationModel,
  catalog: ModelCatalog,
): boolean {
  return versionOf(id, catalog)?.retiredAt !== undefined;
}

export type ModelResolution =
  | { ok: true; model: ConversationModel }
  | {
      ok: false;
      choice: ConversationModel;
      /** `retired`: known, but the Claude CLI no longer offers it. `unknown`: never seen on this machine. */
      reason: "retired" | "unknown";
      retiredReason?: string;
    };

/**
 * THE one place a choice becomes the concrete version that runs. A family
 * resolves to its current version in `catalog`; a pinned version resolves to
 * itself only while the catalog knows it and it is not retired — otherwise the
 * caller gets the reason, never a silent substitute.
 */
export function resolveModel(
  choice: ModelChoice,
  catalog: ModelCatalog,
): ModelResolution {
  if (isModelFamily(choice))
    return { ok: true, model: catalog.current[choice] };
  const version = versionOf(choice, catalog);
  if (!version) return { ok: false, choice, reason: "unknown" };
  if (version.retiredAt !== undefined)
    return {
      ok: false,
      choice,
      reason: "retired",
      ...(version.retiredReason
        ? { retiredReason: version.retiredReason }
        : {}),
    };
  return { ok: true, model: choice };
}

/**
 * A launch or a request named a version that cannot run. An `HttpError`, so
 * every endpoint that lets it propagate answers with the label and what to
 * pick instead — no launch surface has to know about it.
 *
 * Two statuses, one message: `400` when the REQUEST named it
 * (`assertChoiceLaunchable`, at the endpoint boundary — the caller sent a
 * choice it cannot have been offered), `409` when a choice that was valid when
 * it was saved can no longer run at LAUNCH (`requireModel` — the catalog moved
 * under an armed task or a stored agent).
 */
export class ModelUnavailableError extends HttpError {
  constructor(
    readonly resolution: Extract<ModelResolution, { ok: false }>,
    readonly alternatives: ModelChoice[],
    status: 400 | 409 = 409,
  ) {
    super(status, unavailableMessage(resolution, alternatives));
    this.name = "ModelUnavailableError";
  }
}

/** "Opus 4.6 is retired (no longer offered by Claude Code 2.2.0) — pick another: Fable, Opus, …". */
export function unavailableMessage(
  resolution: Extract<ModelResolution, { ok: false }>,
  alternatives: readonly ModelChoice[],
): string {
  const label = choiceLabel(resolution.choice);
  const why =
    resolution.reason === "retired"
      ? `${label} is retired${resolution.retiredReason ? ` (${resolution.retiredReason})` : ""}`
      : `${label} is not a model this machine knows`;
  return `${why} — pick another: ${alternatives.map(choiceLabel).join(", ")}`;
}

/** `resolveModel`, throwing {@link ModelUnavailableError} (409) on a version that cannot run. For launch paths. */
export function requireModel(
  choice: ModelChoice,
  catalog: ModelCatalog,
): ConversationModel {
  const resolution = resolveModel(choice, catalog);
  if (resolution.ok) return resolution.model;
  throw new ModelUnavailableError(resolution, selectableChoices(catalog));
}

/**
 * THE endpoint-boundary check for a choice a request carries. The request
 * schema (`ModelChoiceSchema`) only checks the id GRAMMAR — it cannot see the
 * catalog, which is runtime data — so every handler that accepts a choice
 * calls this before it writes anything: an id this machine never saw, or one
 * it retired, is a 400 listing the choices that can run today.
 */
export function assertChoiceLaunchable(
  choice: ModelChoice,
  catalog: ModelCatalog,
): void {
  const resolution = resolveModel(choice, catalog);
  if (resolution.ok) return;
  throw new ModelUnavailableError(resolution, selectableChoices(catalog), 400);
}

/** The version a family runs today ("5.5"); none for a pinned version, whose label already names it. */
export function choiceHint(
  choice: ModelChoice,
  catalog: ModelCatalog,
): string | undefined {
  return isModelFamily(choice)
    ? modelMeta(catalog.current[choice]).version
    : undefined;
}

/**
 * Session-selectable choices — families first (smartest first), then every
 * known, non-retired pinned version, newest first within each family. Every
 * user-facing model picker and the `visibleModels` config toggles derive from
 * this list. Print-only families (haiku) are valid persisted ids but never
 * session-selectable. THE single place both exclusions are applied.
 */
export function selectableChoices(catalog: ModelCatalog): ModelChoice[] {
  const versions = catalog.versions
    .filter((v) => v.retiredAt === undefined)
    .map((v) => v.id)
    .filter((id) => !isPrintOnlyFamily(modelMeta(id).family))
    .sort(compareModelsNewestFirst);
  return [...SELECTABLE_FAMILIES, ...versions];
}
