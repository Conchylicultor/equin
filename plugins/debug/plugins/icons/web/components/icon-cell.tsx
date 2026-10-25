import type { ReactElement } from "react";
import type { IconFamilyId, IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon, IconFamilyPreview } from "@plugins/ui/plugins/icons/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { fallbackBadge, type CellSource } from "../internal/model";

/** The glyph sizes the page offers, in px → the icon's box. */
export const ICON_SIZES = ["16", "20", "24", "40"] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const SIZE_CLASS: Record<IconSize, string> = {
  "16": "size-4",
  "20": "size-5",
  "24": "size-6",
  "40": "size-10",
};

/**
 * One name as one family draws it: a real `<Icon>` under an
 * `IconFamilyPreview` of that family, so the page shows the app's own drawing.
 * A fallback is dimmed and badged with the initial of the family drawing it;
 * a strict family's gap is its own dashed gap glyph. An app-only glyph (a
 * `CustomRef`) is drawn plain: its family draws it in every scope.
 */
export function IconCell({
  icon,
  family,
  source,
  labelOf,
  size,
  active,
}: {
  icon: IconRef;
  family: IconFamilyId;
  /** Never `absent`: a cell for a glyph not in the set is blank, not an icon. */
  source: Exclude<CellSource, { kind: "absent" }>;
  /** A family id → its label. */
  labelOf: (id: IconFamilyId) => string;
  size: IconSize;
  /** Draw it active: the family's active form. */
  active: boolean;
}): ReactElement {
  const badge = fallbackBadge(source, labelOf);
  const label = labelOf(family);
  const title =
    source.kind === "own"
      ? `${label} · ${icon.name}`
      : source.kind === "glyph"
        ? `${label} · ${icon.name} (its own glyph, no Material name)`
        : source.kind === "gap"
          ? `${label} draws nothing for ${icon.name} (a gap)`
          : `${label} has no ${icon.name} — drawn by ${labelOf(source.family)}`;
  return (
    <IconFamilyPreview family={family}>
      <Stack direction="row" gap="2xs" align="center" justify="center">
        <Icon
          icon={icon}
          active={active}
          title={title}
          className={cn(
            SIZE_CLASS[size],
            source.kind === "own" || source.kind === "glyph"
              ? undefined
              : "opacity-50",
          )}
        />
        {badge !== undefined ? <Badge variant="warning">{badge}</Badge> : null}
      </Stack>
    </IconFamilyPreview>
  );
}
