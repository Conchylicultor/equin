import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The mark's four equal slices — the seeded tag tree's first top-level
 * colours — starting at 45° so they begin at the turned drop's visual top.
 */
const BRAND_FILL =
  "conic-gradient(from 45deg, #f97316 0deg 90deg, #3b82f6 90deg 180deg, #16a34a 180deg 270deg, #a855f7 270deg 360deg)";

/**
 * The app's brand mark (`Apps.App`'s `mark`): a small drop sliced in four tag
 * colours. The app launcher draws it — at the size it passes in `className`.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block -rotate-45 rounded-full rounded-bl-none border-2 border-categorical-foreground shadow-sm",
        className,
      )}
      style={{ background: BRAND_FILL }}
    />
  );
}
