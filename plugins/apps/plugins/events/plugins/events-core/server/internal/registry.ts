import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { FieldsRecord } from "@plugins/fields/core";
import type { JobCtx } from "@plugins/infra/plugins/jobs/server";
import type { ExtractionResult } from "../../core";

/** What a source type is handed on every phase: its own row's validated config. */
export interface ProbeContext<TConfig> {
  sourceId: string;
  config: TConfig;
  /**
   * The run this phase belongs to. Stamp any durable side effect (a model call,
   * a fetched artifact) with it, so the run's ledger row can find that side
   * effect afterwards — the run is the only thing both halves share, and without
   * the id the artifact and the outcome that explains it are two records with no
   * way back to each other.
   *
   * Available DURING the run: the engine mints the id before the first phase,
   * which is what lets in-flight work name a row that is written at the end.
   */
  runId: string;
  /**
   * The job run this phase is part of (every refresh runs in one). A phase that
   * must wait — a model call at the Claude account's usage limit — sleeps the
   * run with `job.sleep` (it frees the worker and resumes the run, from the top,
   * once the time is up) rather than failing it.
   */
  job: Pick<JobCtx, "sleep">;
}

/** What `probe` reports back to the engine. */
export interface ProbeResult<TPayload> {
  /**
   * The cache key over the raw material. `null` is an honest declaration that
   * this source CANNOT be fingerprinted cheaply (a paginated API where probing
   * *is* fetching) — the engine then always extracts. It is not an error value.
   *
   * Fingerprint the NORMALIZED material, never raw HTML: raw markup churns on
   * every request (CSRF nonces, ad slots, build hashes) and defeats the cache.
   */
  fingerprint: string | null;
  /** Threaded straight into `extract`, so the split costs no second fetch. */
  payload: TPayload;
}

/**
 * A kind of thing events can be read from (`url`, `manual`, `shotgun`) — the
 * plugin, never a configured instance (that is a *source*, a row).
 *
 * ## Why two phases instead of one `run()`
 *
 * The split makes the extraction cache **structural**. The engine holds
 * `lastFingerprint`, so it is literally unable to call `extract` on an unchanged
 * source: it compares the probe's fingerprint first and returns
 * `outcome: "unchanged"` without ever reaching the expensive half. A single
 * `run()` returning `{ unchanged } | { events }` would leave "don't pay for the
 * LLM when nothing changed" as per-provider discipline that a future marketplace
 * source type silently forgets — the cost of forgetting being real money, on
 * every tick, invisibly.
 *
 * ## Failure is a type, never an absorbable value
 *
 * `probe` / `extract` **throw**. A plain throw is transient (the refresh job
 * retries); `NonRetryableError` from `@plugins/infra/plugins/jobs/server` is
 * terminal and gets classified onto the source row's `status: "error"` +
 * `lastError`. A source type must NEVER return `events: []` to mean "it broke" —
 * an empty array means the page genuinely lists no events, and the engine will
 * happily stamp `disappearedAt` on everything it previously found.
 *
 * `flags` is not a softer failure either: it reports what the extractor could not
 * EXPRESS, on a run that otherwise succeeded. An event it could not read at all
 * is omitted; an extraction it could not perform still throws.
 */
export interface EventSourceType<TConfig = unknown, TPayload = unknown> {
  /** Matches the row's `type` column and the web `EventSources.Type` id. */
  id: string;
  /**
   * The per-type user input schema. Declared once in the source type's `core/`
   * so the server validates a row's `config` jsonb against
   * `fieldsToZodObject(configFields)` and the web renders the add/configure form
   * generically — a new source type therefore ships zero form code.
   */
  configFields: FieldsRecord;
  /** Cheap. Fetch raw material and fingerprint it. No LLM, no parsing, no writes. */
  probe(ctx: ProbeContext<TConfig>): Promise<ProbeResult<TPayload>>;
  /**
   * Expensive. Only ever called when the fingerprint moved (or is `null`).
   *
   * Returns the source's FULL current set plus the session's `flags` — every
   * identity absent from `events` gets `disappearedAt` stamped, so a partial
   * answer is a data-loss bug, not a smaller answer.
   */
  extract(
    payload: TPayload,
    ctx: ProbeContext<TConfig>,
  ): Promise<ExtractionResult>;
}

// Module-load-time registry, populated by `defineEventSourceType`'s `register()`
// during the framework's register phase (mirrors `defineWallpaperProvider` /
// `defineTrashSource` / `defineHistorySource`). This idiom rather than
// `defineServerContribution` because the engine dispatches BY ID at run time — a
// source row names its type — not by running every contributor.
const registry = new Map<string, EventSourceType>();

/**
 * Register a source type. Returns a {@link Registration} — a lazy registry write
 * the framework applies when the token sits in a plugin's `register: [...]`
 * array.
 */
export function defineEventSourceType<TConfig, TPayload>(
  type: EventSourceType<TConfig, TPayload>,
): EventSourceType<TConfig, TPayload> & Registration {
  return {
    ...type,
    _kind: "event-source-type",
    _factory: "defineEventSourceType",
    _doc: { label: type.id },
    register() {
      if (registry.has(type.id)) {
        throw new Error(`[events] duplicate event source type id: ${type.id}`);
      }
      registry.set(type.id, type as EventSourceType);
    },
  };
}

export function getEventSourceType(id: string): EventSourceType | undefined {
  return registry.get(id);
}

/** Every registered source type, in registration order. */
export function listEventSourceTypes(): EventSourceType[] {
  return [...registry.values()];
}
