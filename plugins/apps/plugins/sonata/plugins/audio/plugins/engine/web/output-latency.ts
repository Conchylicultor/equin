/**
 * A change in the reported latency smaller than this is read as jitter and
 * ignored. Chrome re-estimates `outputLatency` continuously and it wanders by a
 * few milliseconds read to read; followed raw, that wobble would shake the
 * cursor. A real change — another output device — moves it by tens to hundreds
 * of milliseconds and passes at once.
 */
const JITTER_SEC = 0.005;

/**
 * Seconds from a sample being rendered at `ctx.currentTime` to it reaching the
 * ears: the context's own processing latency (`baseLatency`) plus the output
 * device's (`outputLatency` — the OS mixer, the driver, a Bluetooth link).
 * Safari reports no `outputLatency`; there only `baseLatency` is known.
 *
 * Read on demand (every frame by the transport): both are live properties, so
 * switching the output device is followed with no listener.
 */
export function createOutputLatency(ctx: AudioContext): { read(): number } {
  let held: number | null = null;
  return {
    read() {
      // Typed as always present, but Safari leaves it undefined.
      const output: number | undefined = ctx.outputLatency;
      const reported = ctx.baseLatency + (output ?? 0);
      if (held === null || Math.abs(reported - held) > JITTER_SEC) {
        held = reported;
      }
      return held;
    },
  };
}
