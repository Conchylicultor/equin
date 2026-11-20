import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * One source of box-link signals: a plugin shipping on the box says "this
 * changed" to the computer holding the link. `subscribe` starts listening
 * and resolves to the unsubscribe once listening (resolve-then-read: a change
 * committed after it resolved is signalled); `emit(payload)` sends a signal
 * frame `{ source, payload }`. The payload is the source's own vocabulary —
 * its consumer on the computer (`onBoxSignal(source, …)`) parses it with the
 * same plugin's schema.
 *
 * A source coalesces its own storms: the link carries doorbells, not data,
 * and one ring per change is never needed.
 */
export interface BoxSignalSpec {
  /** The source's id — unique per release, named in the hello's `signals`. */
  source: string;
  subscribe(emit: (payload: unknown) => void): Promise<() => void>;
}

/**
 * The box link's signal sources. The stream route subscribes to every one
 * for as long as a link holds the stream open, and lists them in its hello;
 * it never names a contributor.
 */
export const BoxSignal = defineServerContribution<BoxSignalSpec>(
  "box-link.signal",
  { docLabel: (s) => s.source },
);
