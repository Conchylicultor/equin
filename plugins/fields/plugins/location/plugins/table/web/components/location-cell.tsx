import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  LocationSchema,
  locationLabel,
} from "@plugins/fields/plugins/location/core";

/** Read-only location cell: the address, else `lat, lng`. */
export function LocationCell(props: TableCellProps): ReactNode {
  if (props.value === null || props.value === undefined) return null;
  return (
    <Text variant="caption">
      {locationLabel(LocationSchema.parse(props.value))}
    </Text>
  );
}
