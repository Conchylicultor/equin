import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { type ComponentPropsWithoutRef, type ReactNode } from "react";

// Shared button styling for the JSONL row action strip. The strip handles
// hover-reveal — individual buttons stay simple. Use `rowActionClass()` when
// applying the same styling to a non-Button element (e.g. a base-ui trigger
// rendered as its own native button).
export function rowActionClass(extra?: string): string {
  // eslint-disable-next-line layout/no-adhoc-layout -- shared class-string helper for native/base-ui buttons (not JSX); rigid centered action glyph
  return cn(
    "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground",
    extra,
  );
}

interface RowActionButtonProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "title"
> {
  /** The action's name: its tooltip and accessible name. */
  tooltip: string;
  active?: boolean;
  children: ReactNode;
}

export function RowActionButton({
  tooltip,
  active,
  className,
  children,
  onClick,
  ...rest
}: RowActionButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      aspect="icon"
      // eslint-disable-next-line layout/no-adhoc-layout, control-size/no-adhoc-density -- rigid action-glyph leaf in the hover-reveal row strip; never shrinks, sanctioned fixed 20px glyph
      className={cn(
        "size-5 shrink-0 text-muted-foreground hover:text-foreground",
        active && "bg-accent text-accent-foreground",
        className,
      )}
      tooltip={tooltip}
      aria-label={tooltip}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </Button>
  );
}
