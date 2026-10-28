import type { ReactNode } from "react";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";

/**
 * Read-only identifier cell: the value in the code role, truncated on one
 * line with the whole value in its tooltip, and a copy button revealed while
 * the cell is hovered. The copy click stops at the button — it never activates
 * the row beneath it. An absent value (null, "") draws nothing.
 */
export function IdentifierCell(props: TableCellProps): ReactNode {
  const { value } = props;
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  return (
    <Line className={`${hoverRevealGroup} ${yieldClass("x")} gap-2xs`}>
      <Text variant="code" title={text}>
        {text}
      </Text>
      <CopyButton
        text={text}
        tooltip="Copy"
        aspect="inline"
        className={hoverRevealTarget}
        onClick={(e) => e.stopPropagation()}
      />
    </Line>
  );
}
