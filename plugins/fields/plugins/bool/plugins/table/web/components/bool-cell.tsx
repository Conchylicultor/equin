import type { ReactNode } from "react";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");
const removeIcon = symbol("remove");

/**
 * Read-only boolean cell: a check for truthy, a muted dash otherwise. The glyph
 * sits in an `Inline` box: a bare `<svg>` is block-level (preflight), so in a
 * text run — a list row's subtitle — it would break the line.
 */
export function BoolCell(props: TableCellProps): ReactNode {
  return (
    <Inline gap="none">
      {props.value ? (
        <Icon icon={checkIcon} className="text-foreground" aria-label="true" />
      ) : (
        <Icon
          icon={removeIcon}
          className="text-muted-foreground"
          aria-label="false"
        />
      )}
    </Inline>
  );
}
