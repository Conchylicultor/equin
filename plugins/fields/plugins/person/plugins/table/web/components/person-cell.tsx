import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";

/**
 * Read-only person cell: a small avatar carrying the name's initial (its
 * colour derived from the name, so one person is one colour everywhere) beside
 * the name, truncated on one line. An absent value (null, "") draws nothing.
 */
export function PersonCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === null || value === undefined) return null;
  const name = String(value).trim();
  if (name === "") return null;
  return (
    <Line className={`${yieldClass("x")} gap-xs`}>
      <ControlSizeProvider size="xs">
        <Avatar fallbackGlyph={name} fallbackKey={name} />
      </ControlSizeProvider>
      <Text title={name}>{name}</Text>
    </Line>
  );
}
