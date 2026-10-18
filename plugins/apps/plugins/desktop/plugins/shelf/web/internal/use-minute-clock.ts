import { useEffect, useState } from "react";

/**
 * The current time, re-read at every minute boundary: the tray clock's
 * ticker. A clock, not polling — there is no source to watch for "the minute
 * changed", so a timeout is re-armed for the next boundary each time it fires
 * (aligned to the minute, unlike `useNow(60_000)`, whose tick lands anywhere
 * inside the minute and can show the old one for up to 59 s).
 */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          arm();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** `10:42`: 24-hour, as the mockup's tray reads (en-GB). */
export function formatClockTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** `Fri 16 Oct` (en-GB, without the comma some engines put after the day). */
export function formatClockDate(d: Date): string {
  return d
    .toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(",", "");
}
