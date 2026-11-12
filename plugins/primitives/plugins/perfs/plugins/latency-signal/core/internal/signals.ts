import { defineObservationSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * Every client latency signal and the phases its total splits into, in order.
 * Closed plain data: a new signal is an entry here (then a slow-ops threshold
 * and an emit site — tsc demands the first, see CLAUDE.md).
 *
 * - `update`: a server-side change → its pushed frame applied to the client
 *   cache. `watch-delivery` (a file's write → the host's watch heard it; 0
 *   for a change no watch heard), `server-notice` (then → first notify),
 *   `throttle-hold` (the
 *   resource's own declared `throttleMs` holding the drain), `server-deliver`
 *   (the rest of notify → send), `transport` (send → the frame reached the
 *   browser: the socket's SharedWorker stamps its arrival, off the page's main
 *   thread; the one phase that crosses clocks), `page-wait` (arrival → this
 *   tab's handler ran: the page's main thread was busy), `client-apply`
 *   (handler → cache written).
 * - `confirm`: an optimistic write dispatched → confirmed by the server.
 *   `send-lane` (dispatch → first send), `retry` (first → last send), then the
 *   last send's round trip split by stamps the page's main thread does not
 *   take — the browser's Resource Timing entry for the request and the
 *   server's own `Server-Timing` handler time: `request-queue` (send → the
 *   request left the browser), `network` (request out → last byte back, less
 *   the server's time), `server` (the handler, as the server timed it),
 *   `page-resume` (last byte back → the page's continuation ran); or, when the
 *   request could not be timed so, all of it in `ack-unsplit` (the split
 *   phases then 0, and `ack-unsplit` 0 whenever the split exists). Then
 *   `confirm-frame` (ack → confirmation).
 * - `turn-echo`: the agent took a sent message (its ledger row's
 *   `submittedAt`) → the transcript line it wrote is in this tab's window,
 *   so its "Sending…" echo is gone. `agent-write` (taken → the line's own
 *   timestamp: the agent's CLI writing it), `delivery` (the line written →
 *   on screen: the host's watch hearing the file, the server and the push —
 *   the `update` sample of the same frame splits it further).
 */
export const CLIENT_LATENCY_SIGNALS = {
  update: [
    "watch-delivery",
    "server-notice",
    "throttle-hold",
    "server-deliver",
    "transport",
    "page-wait",
    "client-apply",
  ],
  confirm: [
    "send-lane",
    "retry",
    "request-queue",
    "network",
    "server",
    "page-resume",
    "ack-unsplit",
    "confirm-frame",
  ],
  "turn-echo": ["agent-write", "delivery"],
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
 *   too filed one server slowness twice, once per side. So is an update's
 *   `watch-delivery`: the host's file watch hearing the write, which the
 *   server judges as `bg watch-delivery:<backend>` (split at its arming). Likewise a confirm's
 *   `server` phase is the handler's time, which the server files as its own
 *   route span (`POST /api/…`) when slow.
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
  update: {
    "watch-delivery": "server",
    "throttle-hold": "declared",
    "server-deliver": "server",
  },
  // The handler's own time: the server files its route span when slow.
  confirm: { server: "server" },
  // Both are what the user waits on; neither is judged anywhere else.
  "turn-echo": {},
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
   * Measured end − start. A consumer places the sample on the wall clock as
   * `[endedAt − totalMs, endedAt]` and asks `primitives/perfs/page-pauses`
   * whether the page was hidden, frozen or stalled inside it — no producer
   * tracks visibility itself.
   */
  readonly totalMs: number;
  /**
   * When the operation ended (epoch ms) — set by a producer that emits LATER
   * than that (a confirm waits for its request's Resource Timing entry).
   * Absent: emitted at its end, so `Date.now()` at the emit is its end.
   */
  readonly endedAt?: number;
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
