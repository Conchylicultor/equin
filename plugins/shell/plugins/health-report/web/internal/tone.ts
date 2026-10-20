import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { HealthLevel, HealthState, RowLevel } from "../../core";

/** The dot's fill for each level. Theme tokens only. */
export const DOT_CLASS: Record<HealthLevel, ClassName> = {
  ok: cn("bg-success"),
  attention: cn("bg-warning"),
  critical: cn("bg-destructive"),
  unknown: cn("bg-muted-foreground/50"),
};

/**
 * The halo the bar's dot wears: a 3px ring of its own tone at 18%, so the
 * one always-visible mark in the action bar reads as a lit status light
 * rather than a speck. Not-known-yet has none — it is not a status yet. The
 * report's own rows draw the plain dot.
 */
export const DOT_HALO_CLASS: Record<HealthLevel, ClassName> = {
  ok: cn("ring-3 ring-success/18"),
  attention: cn("ring-3 ring-warning/18"),
  critical: cn("ring-3 ring-destructive/18"),
  unknown: cn(""),
};

/** Summary text colour: only a row that needs a look is tinted. */
export const SUMMARY_CLASS: Record<RowLevel, ClassName> = {
  ok: cn("text-muted-foreground"),
  attention: cn("text-warning"),
  critical: cn("text-destructive"),
  unknown: cn("text-muted-foreground"),
  "not-applicable": cn("text-muted-foreground"),
};

/**
 * The button's tint while some row needs a look: the count's text colour and a
 * tinted hover / expanded fill, overriding the ghost button's neutral hover
 * (tailwind-merge keeps the later class). No border and no resting fill — the
 * button sits flat in the action bar like every other control, so the dot and
 * its count are what carry the alarm, not an outlined pill inside the bar.
 */
export const BUTTON_TINT_CLASS: Record<
  Exclude<HealthState, "ok">,
  ClassName
> = {
  attention: cn(
    "text-warning hover:bg-warning/15 hover:text-warning aria-expanded:bg-warning/15 aria-expanded:text-warning",
  ),
  critical: cn(
    "text-destructive hover:bg-destructive/15 hover:text-destructive aria-expanded:bg-destructive/15 aria-expanded:text-destructive",
  ),
};
