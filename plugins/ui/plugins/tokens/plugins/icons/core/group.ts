import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";
import {
  DEFAULT_ICON_STYLE,
  ICON_FILLS,
  ICON_SHAPES,
  ICON_WEIGHTS,
  isIconFamilyId,
  type IconStyle,
} from "@plugins/ui/plugins/icons/core";

const choices = (values: readonly string[]) => values.join(" | ");

/**
 * How a theme scope draws its icons: which family (Material Symbols, or a
 * contributed family — Lucide, an app's own — `Icons.Family`) and which Material Symbols style `<Icon>` picks
 * a glyph from. Not CSS — an icon's style is WHICH sprite symbol it uses, so
 * the icons token bridge reads the resolved values and publishes them to the
 * icons primitive. The CSS variables are painted like every group's, and read
 * by nothing.
 *
 * Defaults: Material, outline at rest, filled when active, regular stroke,
 * default shape. The Material axes still matter in another family's scope:
 * they style the symbols that family does not draw.
 */
export const iconsGroup = defineTokenGroup("icons", {
  iconFamily: {
    default: DEFAULT_ICON_STYLE.family,
    label: "Icon family (material, or a contributed family's id)",
  },
  iconShape: {
    default: DEFAULT_ICON_STYLE.shape,
    label: `Icon shape (${choices(ICON_SHAPES)})`,
  },
  iconFill: {
    default: DEFAULT_ICON_STYLE.fill,
    label: `Icon fill (${choices(ICON_FILLS)})`,
  },
  iconActiveFill: {
    default: DEFAULT_ICON_STYLE.activeFill,
    label: `Active icon fill (${choices(ICON_FILLS)})`,
  },
  // Not `iconWeight`: a `-weight` var is a type metric, which only the
  // type-scale role ladder may declare (`type-scale:closed-role-ladder`). This
  // is a stroke choice between two icon sets, not a font weight.
  iconStroke: {
    default: DEFAULT_ICON_STYLE.weight,
    label: `Icon stroke (${choices(ICON_WEIGHTS)})`,
  },
});

export type IconsTokenValues = {
  [K in keyof typeof iconsGroup.schema]: string;
};

function oneOf<T extends string>(
  token: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  if (value !== undefined && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(
    `[icons] token ${token} is "${value}" — it must be one of ${choices(allowed)}`,
  );
}

/**
 * The family is an open set (contributed on the web, possibly by a plugin not
 * loaded yet), so only its spelling is checked here; a well-spelled id no
 * family answers draws Material.
 */
function familyId(value: string | undefined): string {
  if (value !== undefined && isIconFamilyId(value)) return value;
  throw new Error(
    `[icons] token iconFamily is "${value}" — it must be a family id (lowercase, kebab-case)`,
  );
}

/**
 * The icon style one resolution of the group says. A value outside the
 * vocabulary (a hand-edited theme) throws: an icon style is a choice among
 * sprites, and there is no sprite to fall back to that would not be a guess.
 */
export function readIconTokens(
  values: Readonly<Record<string, string | undefined>>,
): IconStyle {
  return {
    family: familyId(values.iconFamily),
    shape: oneOf("iconShape", values.iconShape, ICON_SHAPES),
    fill: oneOf("iconFill", values.iconFill, ICON_FILLS),
    activeFill: oneOf("iconActiveFill", values.iconActiveFill, ICON_FILLS),
    weight: oneOf("iconStroke", values.iconStroke, ICON_WEIGHTS),
  };
}
