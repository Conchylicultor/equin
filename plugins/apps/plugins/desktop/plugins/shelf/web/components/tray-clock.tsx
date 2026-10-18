import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  formatClockDate,
  formatClockTime,
  useMinuteClock,
} from "../internal/use-minute-clock";

/**
 * The tray's clock (mockup `.tray-clock`): `10:42` over `Fri 16 Oct`,
 * right-aligned, tabular figures. The date drops below 1100px of viewport,
 * the whole clock below 760px, as in the mockup.
 */
export function TrayClock() {
  const now = useMinuteClock();
  return (
    <time
      dateTime={now.toISOString()}
      // eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.tray-clock` column, right-aligned, padding 0 8px 0 6px (6px is off the ramp)
      className={cn(
        rigidClass(),
        "flex flex-col items-end pr-sm pl-[6px] text-caption font-[550] whitespace-nowrap tabular-nums max-[760px]:hidden",
      )}
    >
      <span>{formatClockTime(now)}</span>
      <span className="font-[450] text-foreground/52 max-[1100px]:hidden">
        {formatClockDate(now)}
      </span>
    </time>
  );
}
