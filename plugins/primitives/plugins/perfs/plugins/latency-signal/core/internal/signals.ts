import { defineObservationSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * Every client latency signal and the phases its total splits into, in order.
 * Closed plain data: a new signal is an entry here (then a slow-ops threshold
 * and an emit site — tsc demands the first, see CLAUDE.md).
 *
 * - `update`: a server-side change → its pushed frame applied to the client
 *   cache. `server-notice` (change → first notify), `throttle-hold` (the
 *   resource's own declared `throttleMs` holding the drain), `server-deliver`
 *   (the rest of notify → send), `transport` (send → receipt; the one phase
 *   that crosses clocks), `client-apply` (receipt → cache written).
 * - `confirm`: an optimistic write dispatched → confirmed by the server.
 *   `send-lane` (dispatch → first send), `retry` (first → last send),
 *   `server-ack` (last send → ack), `confirm-frame` (ack → confirmation).
 */
export const CLIENT_LATENCY_SIGNALS = {
  update: [
    "server-notice",
    "throttle-hold",
    "server-deliver",
    "transport",
    "client-apply",
  ],
  confirm: ["send-lane", "retry", "server-ack", "confirm-frame"],
} as const;

export type ClientLatencySignal = keyof typeof CLIENT_LATENCY_SIGNALS;

/** The phase names of one signal. */
export type PhaseOf<S extends ClientLatencySignal> =
  (typeof CLIENT_LATENCY_SIGNALS)[S][number];

/**
 * Why a phase is not the operation's own time:
 * - `declared`: held by design — the resource's declared `throttleMs` (a 1000 ms
 *   throttle judged against a 1000 ms bar would read as "slow" on every change).
 * - `server`: a window the server judges itself, on its own spans — the
 *   update's notify → send is the server's `push deliver:<key>` span (and the
 *   loader or flush it waited on), each filed there when slow. Counting it here
 *   too filed one server slowness twice, once per side.
 */
export type ExcludedPhaseOwner = "declared" | "server";

/**
 * The phases of each signal that are NOT the operation's own time, each with
 * who owns it. A `Record` over the signals, so a new signal states its own
 * (possibly empty) set. Read through `ownMsOf`.
 */
export const EXCLUDED_PHASES: {
  readonly [S in ClientLatencySignal]: Readonly<
    Partial<Record<PhaseOf<S>, ExcludedPhaseOwner>>
  >;
} = {
  update: { "throttle-hold": "declared", "server-deliver": "server" },
  confirm: {},
};

/**
 * The signals that may be sampled CENSORED — before the operation finished,
 * because it had not finished by a deadline. Only `confirm`: a write that never
 * confirms would otherwise emit nothing, so its stall would be invisible to
 * every consumer. Closed plain data, like the table above.
 */
export const CENSORABLE_SIGNALS = ["confirm"] as const;

export type CensorableSignal = (typeof CENSORABLE_SIGNALS)[number];

/** What every sample carries, whatever its signal and completeness. */
interface SampleBase<S extends ClientLatencySignal> {
  readonly signal: S;
  /** The resource key the latency was measured on. */
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
  /** A free-form sub-kind (e.g. a confirm's `mode/edge`); consumers fall back to the params. */
  readonly variant?: string;
  /**
   * Measured end − start. The sample is emitted synchronously at its end, so a
   * consumer places it on the wall clock as `[Date.now() − totalMs, Date.now()]`
   * and asks `primitives/perfs/page-pauses` whether the page was hidden, frozen
   * or stalled inside it — no producer tracks visibility itself.
   */
  readonly totalMs: number;
}

/** A finished operation's sample: every phase of its signal present, no other. */
interface CompleteSampleOf<
  S extends ClientLatencySignal,
> extends SampleBase<S> {
  /** Each phase's ms, clamped ≥ 0 (see `splitPhases`). */
  readonly phases: Readonly<Record<PhaseOf<S>, number>>;
  readonly censored?: undefined;
}

/**
 * A CENSORED sample: the operation had NOT finished when it was taken (a
 * deadline expired), so `totalMs` is the time elapsed so far — a lower bound —
 * and `phases` holds only the phases it reached (a phase it was still in, or
 * never entered, is absent: which one is missing says where it stalled).
 */
interface CensoredSampleOf<S extends CensorableSignal> extends SampleBase<S> {
  readonly phases: Readonly<Partial<Record<PhaseOf<S>, number>>>;
  readonly censored: true;
  /**
   * Bounded evidence of where it stalled that no phase can carry (a confirm's
   * `ackWatermark`: the commit the server acked, which no frame reflected).
   * Per-operation, so a consumer never keys a breakdown on it.
   */
  readonly detail?: Readonly<Record<string, string>>;
}

/** One signal's samples: complete, or — for a censorable signal — censored. */
type SampleOf<S extends ClientLatencySignal> =
  | CompleteSampleOf<S>
  | (S extends CensorableSignal ? CensoredSampleOf<S> : never);

/** A client latency sample, discriminated on `signal` (and `censored`). */
export type ClientLatencySample = {
  [S in ClientLatencySignal]: SampleOf<S>;
}[ClientLatencySignal];

/** A censored sample of any censorable signal. */
export type CensoredLatencySample = Extract<
  ClientLatencySample,
  { censored: true }
>;

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

/**
 * `splitPhases` for a CENSORED sample: only the phases the operation reached,
 * each clamped to ≥ 0, in table order; an absent (or `undefined`) one stays
 * absent.
 */
export function splitReachedPhases<S extends CensorableSignal>(
  signal: S,
  raw: Readonly<Partial<Record<PhaseOf<S>, number>>>,
): Partial<Record<PhaseOf<S>, number>> {
  const out: Partial<Record<PhaseOf<S>, number>> = {};
  for (const name of CLIENT_LATENCY_SIGNALS[signal] as readonly PhaseOf<S>[]) {
    const ms = raw[name];
    if (ms !== undefined) out[name] = Math.max(0, ms);
  }
  return out;
}

/**
 * The sample's own time: `totalMs` minus its excluded phases
 * (`EXCLUDED_PHASES`), never below 0. What a consumer judging "was this slow"
 * compares to its bar.
 */
export function ownMsOf(sample: ClientLatencySample): number {
  const phases = sample.phases as Readonly<Record<string, number | undefined>>;
  let excluded = 0;
  for (const name of Object.keys(EXCLUDED_PHASES[sample.signal]))
    excluded += phases[name] ?? 0;
  return Math.max(0, sample.totalMs - excluded);
}
