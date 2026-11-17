import { fieldsToZodObject } from "@plugins/fields/core";
import { NonRetryableError } from "@plugins/infra/plugins/jobs/server";
import {
  URL_FETCH_MODES,
  urlSourceConfigFields,
  type UrlFetchMode,
  type UrlSourceConfig,
} from "../../core";

// One zod object, derived from the SAME `configFields` the create/update
// endpoints validate against, so the form, the stored jsonb, and what `probe`
// reads cannot drift.
const schema = fieldsToZodObject(urlSourceConfigFields);

type StoredUrlConfig = Omit<UrlSourceConfig, "fetchMode">;

/**
 * The config as the server actually branches on it.
 *
 * The field atom infers `fetchMode` as `string` — `FieldDef<T>`'s `T` for an
 * enum field is the base type, not the union of its options — so the union has
 * to be re-established exactly once, here, on the way in. Every consumer
 * downstream then gets an exhaustively-checkable value.
 */
export interface UrlSourceRuntimeConfig extends StoredUrlConfig {
  fetchMode: UrlFetchMode;
}

/**
 * Re-read a row's stored `config` as this type's config.
 *
 * `events-core` already validated it on write, so a failure here means the row
 * predates a field change (or was written straight into the DB) — deterministic,
 * so `NonRetryableError`: a retry re-reads the identical row. Loud and terminal
 * beats handing `parsePublicUrl` an `undefined`.
 */
export function readUrlSourceConfig(config: unknown): UrlSourceRuntimeConfig {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new NonRetryableError(
      `Invalid config for a "url" event source: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const values = parsed.data as UrlSourceConfig;
  return { ...values, fetchMode: toFetchMode(values.fetchMode) };
}

/**
 * The `string` → union narrowing, and the one rule about it: it THROWS.
 *
 * A `as UrlFetchMode` cast, or a `?? "auto"`, would be the absorbable failure
 * the repo's rules forbid — a row carrying `"headless"` (a mode renamed in a
 * later version, say) would silently become a plain fetch, and the source would
 * go on quietly reading a challenge page instead of saying it cannot.
 *
 * In practice zod's `z.enum` has already rejected anything outside the set, so
 * this should be unreachable. It stays because "unreachable today" and "safe to
 * cast" are different claims: the cast would survive a later edit that made the
 * field free text, and this would not.
 */
function toFetchMode(value: string): UrlFetchMode {
  const mode = URL_FETCH_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new NonRetryableError(
      `Invalid "fetchMode" on a "url" event source: ${JSON.stringify(value)}. ` +
        `Expected one of ${URL_FETCH_MODES.map((m) => JSON.stringify(m)).join(", ")}.`,
    );
  }
  return mode;
}
