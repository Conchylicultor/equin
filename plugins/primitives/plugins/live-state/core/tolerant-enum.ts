import type { z } from "zod";
import { fallbackTo } from "@plugins/packages/plugins/zod-introspect/core";

/**
 * A `z.ZodType<T>` that accepts a strict enum value OR any unknown string and
 * degrades it to the declared `fallback`. Use for persisted fields backed by an
 * evolving enum (e.g. a model id whose value set changes over time): a
 * legacy/unknown stored value degrades to a concrete `T` instead of rejecting
 * the payload.
 *
 * This matters because live resources parse the whole `z.array(...)` atomically
 * — a single stale row would otherwise throw a `ZodError` on the WS push path
 * and blank the entire list. Tolerating at the field makes that impossible by
 * construction.
 *
 * Per the "fail loudly" rule this is opt-in per field, not a blanket wrapper:
 * every other field still rejects bad input. And the degrade is not silent:
 * the optional `onFallback` callback fires for any value that failed the
 * strict `schema` BEFORE it degrades, so the caller can surface the bad value
 * loudly. It never fires for a valid id — only for legacy/unknown input. The
 * caller decides which fallbacks are expected (silent) vs corrupt (loud); this
 * helper just hands it the raw value.
 *
 * The fallback is a VALUE, not a normalizer: the schema is
 * `schema.catch(fallbackTo(fallback, onFallback))`, which zod-introspect's
 * `describeSchema` reads as data — so a row schema holding a tolerant field
 * stays describable (its fingerprint moves with the enum and the fallback),
 * where a function body would blind it. The fallback must parse against
 * `schema` — checked here, loudly, once.
 *
 * Generic over the schema (not over its value type): a branded schema is an
 * intersection that `z.ZodType<infer T>` reads as its unbranded base, widening
 * the brand away; `z.output<S>` keeps it.
 */
export function tolerantEnum<S extends z.ZodType<string>>(
  schema: S,
  opts: {
    fallback: z.output<S>;
    onFallback?: (raw: unknown) => void;
  },
): z.ZodType<z.output<S>> {
  const checked = schema.safeParse(opts.fallback);
  if (!checked.success) {
    throw new Error(
      `tolerantEnum: the fallback ${JSON.stringify(opts.fallback)} does not parse against its own schema — ${checked.error.message}`,
    );
  }
  return schema.catch(fallbackTo(opts.fallback, opts.onFallback));
}
