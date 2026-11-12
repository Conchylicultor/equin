import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ElapsedTime,
  formatElapsed,
} from "@plugins/primitives/plugins/relative-time/web";
import type { BackgroundShell } from "../../core";
import { shellStateDisplay } from "../internal/state-display";

const CLOCK = "font-mono tabular-nums";

/**
 * One rendering of a background shell's state — dot, label, and how long it
 * has run (ticking) or ran (frozen): `Running 2:49`, `exit 0 · 3:12`,
 * `Failed · exit 1 · 0:04`, `Killed · 1:10`. Shared by the band row, the
 * launching `Bash` card and the output pane.
 */
export function ShellStateChip({
  shell,
  className,
}: {
  /** `startedAt: null` — not on record (a sub-agent's shell): no clock is drawn. */
  shell: Pick<BackgroundShell, "state" | "endedAt"> & {
    startedAt: Date | null;
  };
  className?: string;
}) {
  const display = shellStateDisplay(shell.state);
  return (
    <Inline gap="xs" className={cn("text-muted-foreground", className)}>
      <StatusDot {...display.dot} />
      <Text variant="caption">
        {display.label}
        {display.clock === "live" && shell.startedAt !== null && (
          <>
            {" "}
            <ElapsedTime since={shell.startedAt} className={CLOCK} />
          </>
        )}
        {display.clock === "total" &&
          shell.startedAt !== null &&
          shell.endedAt !== null && (
          <>
            {" · "}
            <span className={CLOCK}>
              {formatElapsed(
                shell.endedAt.getTime() - shell.startedAt.getTime(),
              )}
            </span>
          </>
        )}
      </Text>
    </Inline>
  );
}
