import type { ReactNode } from "react";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { FieldOption } from "../../core";

/** A variant's ink as a dot fill. `muted` / `absent` say nothing about the
 *  value, so their dot is the faint one an option with no colour gets. */
const VARIANT_DOT: Record<BadgeVariant, string> = {
  muted: "bg-faint-foreground",
  primary: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
  success: "bg-success",
  info: "bg-info",
  absent: "bg-faint-foreground",
};

/**
 * One option value drawn QUIET — `● label`, no filled chip: the dot in the
 * option's own colour (its `tint` token, else its `swatch`, else its
 * `variant`'s ink, else faint), the label in the run's own ink. The quiet
 * presentation of a chip-typed cell (`TableCellProps.presentation`), and the
 * read of a tinted option with no `variant`. The `hint` is the label's
 * tooltip, as it is the chip's.
 */
export function QuietOption({
  option,
  label,
}: {
  /** The value's option, when the field declares one. */
  option: FieldOption | undefined;
  /** What to print — the option's label, or the raw value without one. */
  label: string;
}): ReactNode {
  const style =
    option?.tint !== undefined
      ? { backgroundColor: `var(${option.tint})` }
      : option?.swatch !== undefined
        ? { backgroundColor: option.swatch }
        : undefined;
  return (
    <Line as="span" className="gap-xs">
      <span
        aria-hidden
        data-enum-dot=""
        className={cn(
          "inline-block size-[7px] rounded-full",
          rigidClass(),
          style === undefined && VARIANT_DOT[option?.variant ?? "muted"],
        )}
        style={style}
      />
      <Text title={option?.hint}>{label}</Text>
    </Line>
  );
}
