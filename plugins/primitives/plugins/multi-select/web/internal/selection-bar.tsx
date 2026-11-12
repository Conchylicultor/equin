import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactElement, ReactNode } from "react";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useMultiSelect } from "./use-multi-select";

export type SelectionBarProps = {
  actions?: ReactNode;
  className?: string;
};

export function SelectionBar({
  actions,
  className,
}: SelectionBarProps): ReactElement {
  const { selectedCount, isActive, selectAll, clearAll } = useMultiSelect();

  return (
    <Sticky edge="top" layer="float" className="h-0 w-full">
      <Pin
        to="top"
        offset="xs"
        layer="float"
        className={cn(
          "transition-[translate,opacity] duration-200",
          isActive
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-2 opacity-0",
        )}
      >
        <Stack
          direction="row"
          align="center"
          gap="sm"
          className={cn(
            "whitespace-nowrap rounded-lg border bg-background/95 px-lg py-sm text-body shadow-lg backdrop-blur",
            className,
          )}
        >
          <span className="font-medium text-foreground">
            {selectedCount} selected
          </span>
          <button
            type="button"
            onClick={selectAll}
            className="text-muted-foreground hover:text-foreground"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={clearAll}
            className="text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
          {actions && (
            <>
              <div className="bg-border h-4 w-px" />
              <Stack direction="row" align="center" gap="xs">
                {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- bulk-selection bar actions, one per surface, not a per-row cluster */}
                {actions}
              </Stack>
            </>
          )}
        </Stack>
      </Pin>
    </Sticky>
  );
}
