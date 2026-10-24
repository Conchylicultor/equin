import type { ReactElement } from "react";
import type { FieldOptionMeta } from "@plugins/fields/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";

/**
 * A closed-set value as its chip — label, tint and hint straight from the
 * vocabulary's option meta, the same meta the exposed list fields present, so
 * the card and a task list cannot disagree on a label or a tint.
 */
export function OptionBadge({ meta }: { meta: FieldOptionMeta }): ReactElement {
  return (
    <Badge variant={meta.variant ?? "muted"} tooltip={meta.hint}>
      {meta.label}
    </Badge>
  );
}
