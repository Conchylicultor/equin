import { z } from "zod";
import {
  both,
  type TokenGroupFragment,
} from "@plugins/ui/plugins/theme-engine/core";
import { shadowGroup, type ShadowTokenValues } from "./group";

export const DEFAULT_SHADOW_PARAMS: ShadowParams = {
  color: "0 0 0",
  opacity: 0.1,
  blur: "3px",
  spread: "0px",
  offsetX: "0",
  offsetY: "1px",
};

export const ShadowParamsSchema = z.object({
  color: z.string(),
  opacity: z.number(),
  blur: z.string(),
  spread: z.string(),
  offsetX: z.string(),
  offsetY: z.string(),
});

/** The six knobs the shadow editor exposes; every tier is derived from them (`buildShadowTiers`). */
export type ShadowParams = z.infer<typeof ShadowParamsSchema>;

// What a shadow fragment's `meta` holds: the params its tiers were built from,
// so the editor can show and change them again.
const ShadowMetaSchema = z.object({ params: ShadowParamsSchema });

function subtractPx(value: string, amount: number): string {
  const num = parseFloat(value);
  return `${num - amount}px`;
}

export function buildShadowTiers(p: ShadowParams): ShadowTokenValues {
  const c = (mult: number) =>
    `oklch(${p.color} / ${(p.opacity * mult).toFixed(2)})`;
  const spread2 = subtractPx(p.spread, 1);

  return {
    "shadow-2xs": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(0.5)}`,
    "shadow-xs": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(0.5)}`,
    "shadow-sm": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 1px 2px ${spread2} ${c(1.0)}`,
    shadow: `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 1px 2px ${spread2} ${c(1.0)}`,
    "shadow-md": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 2px 4px ${spread2} ${c(1.0)}`,
    "shadow-lg": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 4px 6px ${spread2} ${c(1.0)}`,
    "shadow-xl": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(1.0)}, ${p.offsetX} 8px 10px ${spread2} ${c(1.0)}`,
    "shadow-2xl": `${p.offsetX} ${p.offsetY} ${p.blur} ${p.spread} ${c(2.5)}`,
    // Not a tier of its own: a floating panel wears the `md` tier unless a
    // theme sets it apart.
    "shadow-popover": "var(--shadow-md)",
    // Nor this: floating chrome wears the popover's shadow.
    "shadow-float": "var(--shadow-popover)",
  };
}

/**
 * A theme's shadow fragment built from params: every tier (both modes — a
 * shadow has no dark variant), plus the params themselves in `meta`, which the
 * resolver never reads but the editor needs to edit the tiers again.
 */
export function shadowFragment(params: ShadowParams): TokenGroupFragment {
  return shadowGroup.fragment({
    ...both(buildShadowTiers(params)),
    meta: { params },
  });
}

/**
 * The params a shadow fragment's `meta` records, or undefined when the fragment
 * carries none (a tweakcn theme ships only the tiers). A `meta` that is present
 * but malformed is corrupt data and throws.
 */
export function shadowParamsOf(
  meta: Record<string, unknown> | undefined,
): ShadowParams | undefined {
  return meta === undefined ? undefined : ShadowMetaSchema.parse(meta).params;
}
