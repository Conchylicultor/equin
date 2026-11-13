import { z } from "zod";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";

/**
 * What an item asks of the user — a closed set, so the chip before it tells
 * at a glance whether it is worth their attention, without reading the
 * sentence. Ordered by stakes; each with its chip's label and colour, and the
 * line the agent reads when choosing it (`flag_raise`'s schema).
 */
export const FLAG_CATEGORIES = {
  broken: {
    label: "Broken",
    badge: "destructive",
    meaning:
      "something does not work or did not land (the push failed, a failure you could not fix): the user must act",
  },
  decide: {
    label: "Decide",
    badge: "warning",
    meaning: "a choice only the user can make",
  },
  fyi: {
    label: "FYI",
    badge: "info",
    meaning:
      "nothing to do, but important enough to say here — rarely: what is only worth mentioning belongs in your wrap-up",
  },
  other: {
    label: "Other",
    badge: "muted",
    meaning: "needs the user, but is none of the above",
  },
} as const satisfies Record<
  string,
  { label: string; badge: BadgeVariant; meaning: string }
>;

export type FlagCategory = keyof typeof FLAG_CATEGORIES;

export const FlagCategorySchema = z.enum(
  Object.keys(FLAG_CATEGORIES) as [FlagCategory, ...FlagCategory[]],
);
