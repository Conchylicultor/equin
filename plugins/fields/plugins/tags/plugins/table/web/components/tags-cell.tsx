import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { TableCellProps } from "@plugins/primitives/plugins/data-view/web";

/** Read-only tags cell: each tag as a chip on one truncating line, tinted and
 *  explained by its own option (default muted — see the enum twin). */
export function TagsCell(props: TableCellProps): ReactNode {
  const tags = props.values ?? [];
  if (tags.length === 0) return null;
  const optionFor = (v: string) =>
    props.field.options?.find((o) => o.value === v);
  return (
    <Clip className="whitespace-nowrap">
      <Stack direction="row" gap="xs">
        {tags.map((t) => {
          const option = optionFor(t);
          return (
            <Badge
              key={t}
              variant={option?.variant ?? "muted"}
              tooltip={option?.hint}
            >
              {option?.label ?? t}
            </Badge>
          );
        })}
      </Stack>
    </Clip>
  );
}
