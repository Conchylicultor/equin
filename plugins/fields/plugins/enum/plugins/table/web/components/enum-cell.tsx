import type { ReactNode } from "react";
import { NULL_OPTION_KEY, optionKey } from "@plugins/fields/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  QuietOption,
  type TableCellProps,
} from "@plugins/primitives/plugins/data-view/web";

/** Read-only enum cell: the option label as a chip, tinted and explained by the
 *  option itself — or, quiet, as a dot and the label. */
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
  // Quiet (a row view's term — `TableCellProps.presentation`): `● label`, the
  // dot in the option's colour, never a chip. A tinted option with no
  // `variant` reads that way everywhere: the tint is a declared colour token,
  // so a theme re-colouring the token re-colours the dot. A `variant` keeps the
  // chip in a table — it is the stronger statement, and every option before
  // `tint` existed declared one or none.
  if (
    props.presentation === "quiet" ||
    (option?.tint !== undefined && option.variant === undefined)
  ) {
    return <QuietOption option={option} label={option?.label ?? key} />;
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
