import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import "./working-dots.css";

export interface WorkingTextProps {
  /** What is being worked on, in words ("Reading app.tsx"). A new value replays the entrance. */
  children: string;
  className?: string;
}

/**
 * The words beside <WorkingDots>: a highlight sweeping across them while the
 * work goes on, each new label sliding in. Inline, so the caller's `<Text>`
 * keeps the type role and its line container keeps the truncation.
 */
export function WorkingText({ children, className }: WorkingTextProps) {
  // Keyed by the words, so a change remounts the span and replays its entrance.
  return (
    <span key={children} className={cn("working-text", className)}>
      {children}
    </span>
  );
}
