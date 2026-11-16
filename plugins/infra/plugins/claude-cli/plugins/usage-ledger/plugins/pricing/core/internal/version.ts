import { z } from "zod";
import { defineIdKind, type IdOf } from "@plugins/ids/core";
import type { ModelPrice } from "./pricing";

/** A price version's id (`claude_price_versions.id`). */
export const priceVersionIdKind = defineIdKind({
  prefix: "pricev",
  label: "Price version",
});
export type PriceVersionId = IdOf<typeof priceVersionIdKind>;

/**
 * Where a price version came from: a daily LiteLLM refresh, the vendored
 * snapshot (a machine that never fetched), or a hand correction of past
 * prices (a version with an `effective_from` in the past).
 */
export const PRICE_VERSION_SOURCES = [
  "litellm",
  "fallback",
  "correction",
] as const;
export const PriceVersionSourceSchema = z.enum(PRICE_VERSION_SOURCES);
export type PriceVersionSource = z.infer<typeof PriceVersionSourceSchema>;

/** `ModelPrice` as stored on a version (the table it was recorded from). */
export const ModelPriceSchema: z.ZodType<ModelPrice> = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreate5m: z.number(),
  cacheCreate1h: z.number(),
  cacheRead: z.number(),
  inputAbove200k: z.number().optional(),
  outputAbove200k: z.number().optional(),
  cacheCreate5mAbove200k: z.number().optional(),
  cacheCreate1hAbove200k: z.number().optional(),
  cacheReadAbove200k: z.number().optional(),
  fastMultiplier: z.number().optional(),
});
