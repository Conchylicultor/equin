import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";

/**
 * A chip in the conversation header (the model chip, the status chip): a
 * bordered pill whose shape is the header-chip pad tokens (`padChipHeader*`,
 * defaulting to the regular chip's pad) and whose words are the `tag` role —
 * pinned here (`text-tag font-tag`) so the chip keeps the full tag rung even
 * where the ambient control density would step a `Badge` to its compact rung.
 *
 * `colorClass` carries the chip's fill, text and border colours (a status map,
 * or the neutral `chip` / `subtle` roles); the shape is not the caller's.
 * `as="button"` makes it interactive (a popover trigger): `ref` and the rest of
 * the passthrough land on the chip itself, as on a `Badge`.
 */
export function HeaderChip({
  colorClass,
  as,
  children,
  ...rest
}: {
  colorClass: string;
  as?: "span" | "button";
  children: ReactNode;
} & Passthrough) {
  return (
    <Badge
      shape="pill"
      as={as}
      colorClass={colorClass}
      className={
        as === "button"
          ? "border p-chip-header text-tag font-tag hover:opacity-80"
          : "border p-chip-header text-tag font-tag"
      }
      {...rest}
    >
      {children}
    </Badge>
  );
}
