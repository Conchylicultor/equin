# latency-signal

The closed vocabulary of **client latency signals**: how long a user-visible
round trip took, split into named phases so a slow one says WHERE it was slow.
Plain data in `core/` (no runtime of its own); producers emit into
`clientLatencySink` (an observation sink, `primitives/report-sink`) and any
number of consumers subscribe.

| Signal | Phases (in order) | Produced by |
|---|---|---|
| `update` | `server-notice` · `throttle-hold` · `server-deliver` · `transport` · `page-wait` · `client-apply` | `live-state` — a pushed `update` / `delta` frame applied to the cache |
| `confirm` | `send-lane` · `retry` · `request-queue` · `network` · `server` · `page-resume` · `ack-unsplit` · `confirm-frame` | `optimistic-mutation` — an optimistic op confirmed |

- **update** — `server-notice`: change → first notify (`sentAt − deliverMs −
  changedAt`); `throttle-hold`: the resource's declared `throttleMs` holding the
  drain (`holdMs`); `server-deliver`: the rest of notify → send (`deliverMs −
  holdMs`); `transport`: send → the frame reached the browser (`arrivedAt −
  sentAt`, `arrivedAt` stamped by the socket's SharedWorker —
  `primitives/networking`); `page-wait`: arrival → this tab's handler ran (its
  main thread busy); `client-apply`: handler → cache written. `transport` is
  the **only phase that crosses clocks** (server send stamp vs browser arrival
  stamp), so clock skew lands in that one named layer; same-machine is the
  documented assumption. Timing rides the frame (`resource-protocol`'s
  `timing` field).
- **confirm** — `send-lane`: dispatch → first send; `retry`: first → last
  send; then the last send → ack window, split by its request's own timing:
  `request-queue` (send → the request left the browser), `network` (request
  out → last byte back, less the server's time), `server` (the handler's own
  time), `page-resume` (last byte back → the page's continuation ran) — or all
  of it in `ack-unsplit` when the request could not be timed (the four then 0,
  and `ack-unsplit` 0 whenever they are set); `confirm-frame`: ack →
  confirmation (0 when the confirmation beat the ack). Stamps on the client's
  monotonic clock (Resource Timing shares it) or durations, so no skew.

**Phases that cannot lie.** A phase measured as two `performance.now()` /
`Date.now()` reads around an `await` charges the page's busy main thread to
whatever it awaited: the confirm's old `server-ack` (last send → the `.then`
ran) read ~107 ms on page-blocks writes whose handler took 13 ms
(2026-11-04), and an investigation was filed against the server. So every
boundary between "the page" and "not the page" is a stamp the page's main
thread does not take: the SharedWorker's socket arrival (`update`), and the
request's Resource Timing entry plus the server's `Server-Timing` handler time
(`confirm`; `framework/http-router` stamps every routed response,
`primitives/networking`'s `requestTimingOf` reads both). The page's own waits
are their own phases (`page-wait`, `request-queue`, `page-resume`), so a slow
report names the layer that dominated.

`ClientLatencySample` is a union on `signal` whose `phases` is
`Record<PhaseOf<S>, number>`: tsc rejects a missing, extra or misspelled phase.
`totalMs` is measured end − start, never summed from the phases;
`splitPhases(signal, raw)` clamps each phase to ≥ 0 (a cross-clock or
out-of-order span can come out negative), so a clamped set can sum to more
than the total. `variant` is a free-form sub-kind (a confirm's `mode/edge`);
consumers fall back to the params.

**Own time.** `EXCLUDED_PHASES` names, per signal, the phases that are not
the operation's own time, each with its owner: `declared` (held by design — an
update's `throttle-hold`) or `server` (a window the server judges on its own
spans — an update's `server-deliver` is exactly the server's `push
deliver:<key>` span, so counting it here too filed one server slowness twice;
a confirm's `server` is the handler time its route span is judged on).
`ownMsOf(sample)` is `totalMs` less them, which is what a consumer judging "was
this slow" compares to its bar.

**No visibility flag.** A consumer places a sample on the wall clock as
`[endedAt − totalMs, endedAt]` (`endedAt` absent: emitted at its end, so now —
a confirm sets it, as it waits for its request's Resource Timing entry) and asks
`primitives/perfs/page-pauses` whether the tab was hidden, frozen or stalled
inside it. Producers never track visibility.

**Censored samples.** A signal in `CENSORABLE_SIGNALS` (only `confirm`) may
also be sampled before it finished — a write still unconfirmed at its deadline
(`network/live`'s `armUnconfirmedDeadline`). Such a sample is `censored: true`,
its `totalMs` the time elapsed (a lower bound), its `phases` only the ones
reached (`Partial` — built with `splitReachedPhases`; the absent one is where
it stalled), and an optional bounded `detail` (a confirm's `ackWatermark`). The
union keeps it tsc-checked: an uncensored sample still needs every phase, and
`censored` on a non-censorable signal is an error. A consumer that keys on a
sample must tell the two apart (slow-ops files a censored confirm as
`<key> (unconfirmed)`); one that only aggregates complete totals skips it.

## Adding a signal

1. An entry in `CLIENT_LATENCY_SIGNALS` (its phase tuple).
2. A slow-ops threshold — `CLIENT_SIGNAL_THRESHOLD` is a
   `Record<ClientLatencySignal, …>`, so tsc refuses the build until it exists.
3. An `EXCLUDED_PHASES` entry (a `Record` over the signals, so tsc asks) —
   `{}` when every phase is the operation's own time.
4. An emit site: `clientLatencySink.emit({ signal, key, params, phases:
   splitPhases(signal, …), totalMs })` at the operation's end, guarded by
   `clientLatencySink.hasSubscribers()` when building it costs anything.

Consumers never name a signal: they read `signal` / `phases` generically.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The closed vocabulary of client latency signals (update: a pushed change applied; confirm: an optimistic write confirmed), each a fixed tuple of named phases, as plain data; ClientLatencySample (a union on signal, so a missing or misspelled phase is a tsc error), the clientLatencySink observation sink producers emit into and consumers subscribe to, and splitPhases.
- Core:
  - Uses: `primitives/report-sink.defineObservationSink`
  - Exports (types):
    - `CensoredLatencySample`
    - `ClientLatencySample`
    - `ClientLatencySignal`
    - `PhaseOf`
  - Exports (values):
    - `CLIENT_LATENCY_SIGNALS`
    - `clientLatencySink`
    - `EXCLUDED_PHASES`
    - `ownMsOf`
    - `splitPhases`
    - `splitReachedPhases`
- Cross-plugin:
  - Imported by:
    - `debug/latency-ledger`
    - `debug/slow-ops`
    - `network/live`
    - `network/live/live-state`
    - `network/live/optimistic-mutation`

<!-- AUTOGENERATED:END -->
