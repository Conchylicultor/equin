import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export interface PlaceholderProps {
  children: React.ReactNode;
  tone?: "muted" | "error";
}

/**
 * Muted (or error) text standing for a loading, empty or failed state.
 *
 * It declares only its block padding: its inline edge is the region's, like
 * any content (research/2026-11-09-global-surface-owned-inset.md, slice 3).
 * In a padded region it lands on the rail, level with the labels and rows
 * around it; in a row host (`rail-rows`) `rail-text-indent` moves it one row
 * pad further, onto the rows' TEXT edge. It never pays the rail itself — so a
 * Placeholder with nothing padding it sits flush: give that spot an owner (a
 * region, `PaneChrome inset="document"`), never an inset on the Placeholder.
 */
export function Placeholder({ children, tone = "muted" }: PlaceholderProps) {
  return (
    <div
      className={cn(
        "rail-text-indent py-sm text-body",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
