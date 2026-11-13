/**
 * How a collector drains one sink: `attach()` registers its handler and
 * answers the detach. Opaque — built only by {@link drain}, so a
 * `ReportSinks.Collector` cannot name a sink without the handler for it.
 */
export interface SinkDrain {
  readonly attach: () => () => void;
}

/** A sink with ONE handler slot: a `ReportSink` or a `RequestSink`. */
interface RegistrableSink<TBody, TResult> {
  register(fn: ((body: TBody) => TResult) | null): void;
}

/** Who holds each sink, and how many hosts attached it. */
const held = new Map<
  RegistrableSink<never, unknown>,
  { drain: SinkDrain; count: number }
>();

/**
 * The drain of `sink` into `handler`, for a `ReportSinks.Collector`
 * contribution. Attaching is counted per sink: the collector host mounts at
 * the page root AND inside every `PluginScope` (`scope: "each"`), and the
 * sink has one handler slot, so the first attach registers, the last detach
 * unregisters, and the attaches between change nothing.
 *
 * Two different drains on one sink THROW: a sink has one handler, so the
 * second would silently evict the first collector.
 */
export function drain<TBody, TResult>(
  sink: RegistrableSink<TBody, TResult>,
  handler: (body: TBody) => TResult,
): SinkDrain {
  const key = sink as RegistrableSink<never, unknown>;
  const self: SinkDrain = {
    attach() {
      const entry = held.get(key);
      if (entry && entry.drain !== self)
        throw new Error(
          "report-sink: two collectors drain the same sink — a sink has one handler, so one of them would silently receive nothing",
        );
      if (entry) entry.count++;
      else {
        held.set(key, { drain: self, count: 1 });
        sink.register(handler);
      }
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const current = held.get(key)!;
        current.count--;
        if (current.count > 0) return;
        held.delete(key);
        sink.register(null);
      };
    },
  };
  return self;
}
