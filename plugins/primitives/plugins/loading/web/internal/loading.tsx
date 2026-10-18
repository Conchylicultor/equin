import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactNode } from "react";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import "./loading.css";

export type LoadingVariant = "text" | "spinner" | "rows" | "cards" | "block";

export interface LoadingProps {
  /** Visual shape of the loading state. Default `"text"`. */
  variant?: LoadingVariant;
  /** Text shown by the `text` and `spinner` variants. Default `"Loading…"` (text only). */
  label?: ReactNode;
  /** Skeleton item count for `rows` (default 6) and `cards` (default 8). */
  count?: number;
  className?: string;
}

/** The atomic shimmer block every skeleton variant is built from. */
function Shimmer({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

/**
 * The single entry point for the LOADING state. Orchestrates the existing
 * leaves — `text` delegates to `Placeholder`, `spinner` to `Spinner`, and the
 * skeleton variants (`rows` / `cards` / `block`) compose the shimmer atom.
 *
 * Every variant mounts invisible and fades in only after ~120ms (see
 * `loading.css`), so a fast load unmounts it before it ever paints — no flash.
 *
 * Every variant is `aria-busy`: the standard "this region is still loading",
 * which assistive tech reads and automation waits on (the agent browser's
 * recordings wait for no busy region before filming a call's result).
 */
export function Loading({
  variant = "text",
  label,
  count,
  className,
}: LoadingProps): ReactNode {
  switch (variant) {
    case "text":
      return (
        <div
          role="status"
          aria-busy="true"
          className={cn("loading-delayed", className)}
        >
          <Placeholder>{label ?? "Loading…"}</Placeholder>
        </div>
      );
    case "spinner":
      return (
        <Stack
          direction="row"
          gap="sm"
          align="center"
          role="status"
          aria-busy="true"
          className={cn(
            "loading-delayed px-md py-sm text-body text-muted-foreground",
            className,
          )}
        >
          <Spinner className={cn("size-4", rigidClass())} />
          {label}
        </Stack>
      );
    case "rows":
      return (
        <Stack
          role="status"
          aria-busy="true"
          aria-label="Loading"
          gap="sm"
          className={cn("loading-delayed rail-follow py-sm", className)}
        >
          {Array.from({ length: count ?? 6 }, (_, i) => (
            <Shimmer key={i} className="h-8 w-full" />
          ))}
        </Stack>
      );
    case "cards":
      return (
        <Grid
          role="status"
          aria-busy="true"
          aria-label="Loading"
          minCellWidth="200px"
          gap="lg"
          className={cn("loading-delayed rail-follow py-sm", className)}
        >
          {Array.from({ length: count ?? 8 }, (_, i) => (
            <Stack key={i} gap="sm">
              <Shimmer className="aspect-video w-full" />
              <Shimmer className="h-4 w-3/5" />
            </Stack>
          ))}
        </Grid>
      );
    case "block":
      return (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading"
          className={cn("loading-delayed", className)}
        >
          <Shimmer className="size-full" />
        </div>
      );
  }
}
