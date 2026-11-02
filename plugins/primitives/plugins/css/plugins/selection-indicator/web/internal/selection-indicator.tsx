import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactElement, ReactNode } from "react";

export type SelectionIndicatorProps = {
  /** Whether the option is selected (filled) or not (empty outline). */
  checked: boolean;
  /** Extra classes for layout — e.g. `self-start` or a `<FirstLine>` wrapper to align with adjacent text. */
  className?: string;
};

/**
 * Shared indicator box. Owns the size, border/fill, and centered glyph; the
 * `shape` is the only thing the two public components differ on. The fixed shape
 * lives here so no consumer ever reaches for a radius class — a checkbox stays a
 * `rounded-checkbox` square and a radio stays a `rounded-full` circle under every
 * Shape preset.
 */
function IndicatorBox({
  checked,
  shape,
  className,
  children,
}: SelectionIndicatorProps & { shape: string; children: ReactNode }): ReactElement {
  return (
    <span
      className={cn(
        "flex size-3 shrink-0 items-center justify-center border",
        checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        shape,
        className,
      )}
    >
      {checked ? children : null}
    </span>
  );
}

/** Square checkbox indicator — a fixed `rounded-checkbox` corner, check glyph when filled. */
export function CheckboxIndicator({ checked, className }: SelectionIndicatorProps): ReactElement {
  return (
    <IndicatorBox checked={checked} shape="rounded-checkbox" className={className}>
      <span className="text-3xs text-white">✓</span>
    </IndicatorBox>
  );
}

/** Round radio indicator — a fixed `rounded-full` circle, inner dot when filled. */
export function RadioIndicator({ checked, className }: SelectionIndicatorProps): ReactElement {
  return (
    <IndicatorBox checked={checked} shape="rounded-full" className={className}>
      <span className="block size-1 rounded-full bg-white" />
    </IndicatorBox>
  );
}
