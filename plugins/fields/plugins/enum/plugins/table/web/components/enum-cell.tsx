import type { ReactNode } from "react";
import { NULL_OPTION_KEY, optionKey } from "@plugins/fields/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";

/** Read-only enum cell: the option label as a chip, tinted and explained by the
 *  option itself. */
export function EnumCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === undefined || value === "") return null;
  // Options are keyed by each value's canonical spelling (`optionKey`): a
  // boolean's `"true"`, and `"null"` for the no-value — drawn only when an
  // option labels it ("By hand", "Unknown").
  const key =
    value === null
      ? NULL_OPTION_KEY
      : value instanceof Date
        ? value.toISOString()
        : optionKey(value);
  // `field.options` is authoritative for every enum field, custom column included
  // — a custom column's private `config.options` is projected onto it by this
  // type's `ColumnConfig.derive` (see fields/enum column-config).
  const option = props.field.options?.find((o) => o.value === key);
  if (value === null && option === undefined) return null;
  // A quiet option labels filters and groups only: no chip in the cell.
  if (option?.quiet === true) return null;
  // A tinted option with no `variant` reads as a coloured dot beside its label
  // (no chip): the tint is a declared colour token, so a theme re-colouring the
  // token re-colours the dot. A `variant` keeps the chip — it is the stronger
  // statement, and every option before `tint` existed declared one or none.
  if (option?.tint !== undefined && option.variant === undefined) {
    return (
      <Line as="span" className="gap-xs">
        <span
          aria-hidden
          data-enum-dot=""
          className={cn("inline-block size-[7px] rounded-full", rigidClass())}
          style={{ backgroundColor: `var(${option.tint})` }}
        />
        <Text title={option.hint}>{option.label}</Text>
      </Line>
    );
  }
  // An option that declares no `variant` is "muted" — the right default for a
  // value with no semantics (every user-authored custom column). `hint` is the
  // option's own explanation of what the value means, spent as the chip's tooltip.
  return (
    <Badge variant={option?.variant ?? "muted"} tooltip={option?.hint}>
      {option?.label ?? key}
    </Badge>
  );
}
