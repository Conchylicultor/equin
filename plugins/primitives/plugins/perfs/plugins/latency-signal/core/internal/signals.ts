import { defineObservationSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * Every client latency signal and the phases its total splits into, in order.
 * Closed plain data: a new signal is an entry here (then a slow-ops threshold
 * and an emit site — tsc demands the first, see CLAUDE.md).
 *
 * - `update`: a server-side change → its pushed frame applied to the client
 *   cache. `server-notice` (change → first notify), `server-deliver` (notify →
 *   send), `transport` (send → receipt; the one phase that crosses clocks),
 *   `client-apply` (receipt → cache written).
 * - `confirm`: an optimistic write dispatched → confirmed by the server.
 *   `send-lane` (dispatch → first send), `retry` (first → last send),
 *   `server-ack` (last send → ack), `confirm-frame` (ack → confirmation).
 */
export const CLIENT_LATENCY_SIGNALS = {
  update: ["server-notice", "server-deliver", "transport", "client-apply"],
  confirm: ["send-lane", "retry", "server-ack", "confirm-frame"],
} as const;

export type ClientLatencySignal = keyof typeof CLIENT_LATENCY_SIGNALS;

/** The phase names of one signal. */
export type PhaseOf<S extends ClientLatencySignal> =
  (typeof CLIENT_LATENCY_SIGNALS)[S][number];

/** One signal's sample: every phase of that signal present, no other. */
interface SampleOf<S extends ClientLatencySignal> {
  readonly signal: S;
  /** The resource key the latency was measured on. */
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
  /** A free-form sub-kind (e.g. a confirm's `mode/edge`); consumers fall back to the params. */
  readonly variant?: string;
  /** Each phase's ms, clamped ≥ 0 (see `splitPhases`). */
  readonly phases: Readonly<Record<PhaseOf<S>, number>>;
  readonly totalMs: number;
  /**
   * The tab was hidden now or at any point since the sample's start stamp — a
   * background tab's timers and frames are throttled, so its number measures
   * the browser, not the system. Consumers exclude it.
   */
  readonly hidden: boolean;
}

/** A client latency sample, discriminated on `signal`. */
export type ClientLatencySample = {
  [S in ClientLatencySignal]: SampleOf<S>;
}[ClientLatencySignal];

/** The one channel client latency samples travel on: producers emit, any number of consumers subscribe. */
export const clientLatencySink = defineObservationSink<ClientLatencySample>();

/**
 * Builds a signal's phases from raw spans, each clamped to ≥ 0: a span across
 * two clocks (or two stamps taken out of order) can come out negative, and a
 * negative layer would credit time to nobody. The phases are consecutive
 * spans, so unclamped they sum to the total; a clamped set sums to more. The
 * sample's `totalMs` is measured end − start, never derived from the phases.
 */
export function splitPhases<S extends ClientLatencySignal>(
  signal: S,
  raw: Readonly<Record<PhaseOf<S>, number>>,
): Record<PhaseOf<S>, number> {
  const out = {} as Record<PhaseOf<S>, number>;
  for (const name of CLIENT_LATENCY_SIGNALS[signal] as readonly PhaseOf<S>[])
    out[name] = Math.max(0, raw[name]);
  return out;
}
