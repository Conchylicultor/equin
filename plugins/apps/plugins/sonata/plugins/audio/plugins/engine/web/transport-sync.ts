import { useEffect, useMemo, type RefObject } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  useCursorApi,
  useSession,
  type DriverReading,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  buildTempoIndex,
  type PlayPosition,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { ScheduleFrom, ScheduleHandle } from "./scheduler";

/**
 * Where a look-ahead schedule built right now starts: the position it starts
 * from and the audio time that position sounds at — or `stalled`, when an
 * external driver owns the transport and is not advancing (nothing may be
 * scheduled).
 *
 * Without a driver this is the cursor's position at the given audio time (its
 * loop rest included, so a resume inside a rest keeps the rest), as every
 * scheduler anchored before drivers existed. With one, it is the DRIVER's
 * position: the cursor trails it by up to a frame, and the medium is the
 * truth the synth must sound against (a driven loop never rests).
 */
export type ScheduleOrigin =
  | { kind: "start"; from: ScheduleFrom; audioAnchor: number }
  | { kind: "stalled" };

export function scheduleOrigin(
  reading: DriverReading,
  cursor: PlayPosition,
  audioTime: number,
): ScheduleOrigin {
  switch (reading.kind) {
    case "internal":
      return {
        kind: "start",
        from: { beat: cursor.beat, rest: cursor.rest },
        audioAnchor: audioTime,
      };
    case "stalled":
      return { kind: "stalled" };
    case "advancing":
      return {
        kind: "start",
        from: { beat: reading.beat, rest: 0 },
        audioAnchor: audioTime,
      };
  }
}

/**
 * How far (seconds, at the playing tempo) a schedule may slip from the driver
 * before it is re-anchored. Below it a slip is inaudible against a recording;
 * above it a drum hit and a synth note stop sounding like one event.
 */
export const DRIFT_TOLERANCE_SEC = 0.04;

/**
 * Keep a running schedule on an external driver's position. While a driver is
 * registered, every cursor write (the transport's rAF tick — render cadence,
 * not a timer) compares the beat the schedule is sounding with the beat the
 * medium is at, and past {@link DRIFT_TOLERANCE_SEC} calls `resync`, which
 * moves the schedule's anchor without cutting a ringing note. Without a driver
 * the schedule and the cursor share one clock and cannot drift, so this does
 * nothing.
 */
export function useDriftCorrection(
  handleRef: RefObject<ScheduleHandle | null>,
  ctx: AudioContext | null,
): void {
  const { driven, readDriver, score } = useSession();
  const cursor = useCursorApi();
  // Seconds are compared at the PLAYING tempo (the scaled score), so the
  // tolerance is wall time whatever the speed.
  const tempo = useMemo(() => buildTempoIndex(score), [score]);
  const tempoRef = useLatestRef(tempo);

  useEffect(() => {
    if (!driven || ctx === null) return;
    return cursor.subscribe(() => {
      const handle = handleRef.current;
      if (handle === null) return;
      const reading = readDriver();
      if (reading.kind !== "advancing") return;
      const now = ctx.currentTime;
      const idx = tempoRef.current;
      const slip =
        idx.beatToSeconds(handle.beatAt(now)) - idx.beatToSeconds(reading.beat);
      if (Math.abs(slip) > DRIFT_TOLERANCE_SEC) {
        handle.resync(reading.beat, now);
      }
    });
  }, [driven, ctx, cursor, readDriver, handleRef, tempoRef]);
}
