import { z } from "zod";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import type { TokenGroupFragment } from "./define-token-group";

export type ThemeId = string;

/**
 * Where a theme comes from. `built-in` themes are code (`defineTheme` +
 * `ThemeEngine.Theme`); `tweakcn` imports and user `custom` themes are rows the
 * saved-themes plugin stores. Only `custom` themes are editable.
 */
export type ThemeSource = "built-in" | "tweakcn" | "custom";

/** The theme every scope starts on: the token groups' schema defaults, untouched. */
export const DEFAULT_THEME_ID: ThemeId = "default";

export const ColorAdjustmentSchema = z.object({
  hueShift: z.number(),
  saturationScale: z.number(),
  lightnessScale: z.number(),
});

/** A hue / saturation / lightness shift applied to every color a theme paints. Mode-independent. */
export type ColorAdjustment = z.infer<typeof ColorAdjustmentSchema>;

/** The adjustment that changes nothing — what a theme chain with no `colorAdjust` resolves to. */
export const NEUTRAL_COLOR_ADJUSTMENT: ColorAdjustment = {
  hueShift: 0,
  saturationScale: 1,
  lightnessScale: 1,
};

const TokenValuesSchema = wholeRecord(z.string(), {
  reason: "one token group's variables — its declared schema",
});

/** The wire / storage form of one `TokenGroupFragment`. */
export const TokenGroupFragmentSchema = z.object({
  groupId: z.string(),
  light: TokenValuesSchema,
  dark: TokenValuesSchema,
  meta: wholeRecord(z.unknown(), {
    reason: "one fragment's import metadata — a few keys",
  }).optional(),
}) satisfies z.ZodType<TokenGroupFragment>;

/** The group a theme names twice, if any — a theme has at most one fragment per group. */
export function duplicateGroupId(
  fragments: readonly { groupId: string }[],
): string | undefined {
  const seen = new Set<string>();
  for (const { groupId } of fragments) {
    if (seen.has(groupId)) return groupId;
    seen.add(groupId);
  }
  return undefined;
}

/**
 * A theme's whole fragment list, as persisted. Rejects two fragments for one
 * group: which of them wins would depend on array order, which nothing else
 * treats as meaningful.
 */
export const TokenGroupFragmentsSchema = wholeList(TokenGroupFragmentSchema, {
  reason: "at most one fragment per token group — tens of groups",
}).superRefine((fragments, ctx) => {
    const dup = duplicateGroupId(fragments);
    if (dup !== undefined) {
      ctx.addIssue({
      code: "custom",
        message: `two fragments for token group "${dup}" — a theme has at most one per group`,
      });
    }
  });

/**
 * A theme: a named, sparse set of token values across the token groups. A group
 * the theme (and its `extends` chain) never mentions paints that group's schema
 * defaults — never another scope's setting — so a partial theme is safe.
 */
export interface Theme {
  id: ThemeId;
  label: string;
  source: ThemeSource;
  /** The theme this one layers on top of. Its values show wherever this one is silent. */
  extends?: ThemeId;
  /** Sparse: at most one per group, and only the groups this theme has an opinion on. */
  fragments: TokenGroupFragment[];
  colorAdjust?: ColorAdjustment;
}

/**
 * Ids are a two-part grammar. A code theme's id is a bare word (`default`,
 * `equin`); a stored theme's is `<source>:<key>` (`tweakcn:catppuccin`,
 * `custom:<uuid>`). The colon is reserved for stored themes, so the two can
 * never collide, and a server that sees only the stored half can still tell
 * which ids it is responsible for.
 */
export function isBuiltInThemeId(id: ThemeId): boolean {
  return !id.includes(":");
}

/** Declare a code theme, contributed through `ThemeEngine.Theme`. */
export function defineTheme(def: {
  id: ThemeId;
  label: string;
  fragments: TokenGroupFragment[];
  colorAdjust?: ColorAdjustment;
}): Theme {
  if (!isBuiltInThemeId(def.id)) {
    throw new Error(
      `defineTheme: id "${def.id}" contains ":", which is reserved for saved themes (\`tweakcn:<id>\`, \`custom:<uuid>\`) — use a bare word.`,
    );
  }
  const dup = duplicateGroupId(def.fragments);
  if (dup !== undefined) {
    throw new Error(
      `defineTheme("${def.id}"): two fragments for token group "${dup}" — a theme has at most one per group.`,
    );
  }
  return { ...def, source: "built-in" };
}
