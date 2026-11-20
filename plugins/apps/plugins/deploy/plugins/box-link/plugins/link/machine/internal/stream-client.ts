import {
  NdjsonParseError,
  readNdjson,
} from "@plugins/infra/plugins/ndjson-stream/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { armAwakeDeadline } from "@plugins/packages/plugins/deadline/core";
import {
  BOX_LINK_STREAM_PATH,
  readBoxFrame,
  type BoxBeatFrame,
  type BoxHelloFrame,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";

/** No frame for this long (three missed beats): the stream is dead. */
export const STREAM_WATCHDOG_MS = 45_000;

/** Reconnect backoff after a failed or ended stream: 2 s doubling to 2 min. */
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 2 * 60_000;

/** How the stream request reaches the box. */
export type StreamTransport = (
  path: string,
  signal: AbortSignal,
) => Promise<Response>;

/** What one stream tells its link, frame by frame. */
export interface StreamEvents {
  hello(frame: BoxHelloFrame): void;
  beat(frame: BoxBeatFrame): void;
  signal(source: string, payload: unknown): void;
  /** The box has no stream route (404): idle until kicked. */
  routeMissing(error: string): void;
  /** The stream failed or ended — see {@link StreamFailure}. */
  failed(failure: StreamFailure): void;
}

/**
 * How one attempt failed. `answered`: the box itself answered (an HTTP
 * error, a stream it closed, a frame it sent wrong) — so the transport
 * carried the request and equin is what failed. Otherwise nothing came back
 * (the request or the connection broke, or silence): through a tunnel, that
 * cannot tell the tunnel dying from equin not listening. `startedAt` is
 * when the attempt began (epoch ms).
 */
export interface StreamFailure {
  error: string;
  answered: boolean;
  startedAt: number;
}

/** Why one attempt ended. */
type AttemptEnd =
  | { kind: "route-missing"; error: string }
  | { kind: "failed"; error: string; answered: boolean; heardHello: boolean }
  | { kind: "aborted" };

class WatchdogFired extends Error {
  constructor() {
    super(`no frame from the box for ${String(STREAM_WATCHDOG_MS / 1000)} s`);
    this.name = "WatchdogFired";
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error
      ? `${err.message} (${cause.message})`
      : err.message;
  }
  return String(err);
}

/**
 * One attempt: open the stream, read it to its end. Every frame re-arms the
 * watchdog (awake time: a sleep is the wake kick's to handle, not a timeout).
 * A malformed frame or line is a protocol bug — reported, and the attempt
 * ends as failed.
 */
async function attempt(
  transport: StreamTransport,
  events: StreamEvents,
  outer: AbortSignal,
): Promise<AttemptEnd> {
  const inner = new AbortController();
  const onOuter = () => inner.abort(outer.reason);
  outer.addEventListener("abort", onOuter, { once: true });
  let cancelWatchdog = () => {};
  const arm = () => {
    cancelWatchdog();
    cancelWatchdog = armAwakeDeadline(STREAM_WATCHDOG_MS, () =>
      inner.abort(new WatchdogFired()),
    );
  };
  let heardHello = false;
  try {
    arm();
    let res: Response;
    try {
      res = await transport(BOX_LINK_STREAM_PATH, inner.signal);
    } catch (err) {
      if (outer.aborted) return { kind: "aborted" };
      if (inner.signal.reason instanceof WatchdogFired) {
        return {
          kind: "failed",
          error: inner.signal.reason.message,
          answered: false,
          heardHello,
        };
      }
      // No answer: the tunnel died, or it is up and nothing answers behind
      // it (ssh: "connect failed") — the link manager tells which.
      return {
        kind: "failed",
        error: `the stream request failed: ${errorText(err)}`,
        answered: false,
        heardHello,
      };
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return {
        kind: "route-missing",
        error: "the box answered 404 for the box-link stream",
      };
    }
    if (!res.ok || res.body === null) {
      await res.body?.cancel();
      return {
        kind: "failed",
        error: `the box answered HTTP ${String(res.status)}`,
        answered: true,
        heardHello,
      };
    }
    try {
      for await (const value of readNdjson(res.body, inner.signal)) {
        arm();
        const read = readBoxFrame(value);
        switch (read.kind) {
          case "skip":
            break;
          case "producer-error":
            return {
              kind: "failed",
              error: `the box's stream failed: ${read.message}`,
              answered: true,
              heardHello,
            };
          case "malformed":
            reportServerError({
              message: `[box-link] a malformed stream frame: ${read.message}`,
              scope: "box-link:stream-frame",
            });
            return {
              kind: "failed",
              error: `a malformed frame: ${read.message}`,
              answered: true,
              heardHello,
            };
          case "frame": {
            const frame = read.frame;
            if (frame.kind === "hello") {
              heardHello = true;
              events.hello(frame);
            } else if (frame.kind === "beat") events.beat(frame);
            else events.signal(frame.source, frame.payload);
            break;
          }
        }
      }
      // A chunked stream only ends cleanly on the box's own last chunk.
      return {
        kind: "failed",
        error: "the box closed the stream",
        answered: true,
        heardHello,
      };
    } catch (err) {
      if (outer.aborted) return { kind: "aborted" };
      if (err instanceof WatchdogFired) {
        return {
          kind: "failed",
          error: err.message,
          answered: false,
          heardHello,
        };
      }
      if (err instanceof NdjsonParseError) {
        reportServerError({
          message: `[box-link] an unparseable stream line: ${err.message}`,
          scope: "box-link:stream-frame",
        });
        return {
          kind: "failed",
          error: err.message,
          answered: true,
          heardHello,
        };
      }
      // The connection broke mid-stream (the tunnel or the box went away).
      return {
        kind: "failed",
        error: `the stream broke: ${errorText(err)}`,
        answered: false,
        heardHello,
      };
    }
  } finally {
    cancelWatchdog();
    outer.removeEventListener("abort", onOuter);
    inner.abort();
  }
}

/**
 * One deployment's stream client: while enabled, it holds the stream open,
 * reconnecting after a failure with a bounded backoff (a bound around a
 * network peer — the box — not a fix for our own code; reset by a hello).
 * A 404 leaves it idle until `kick()`. `kick()` reconnects now (skipping a
 * backoff wait), `disable()` drops the stream and any wait.
 */
export interface StreamClient {
  enable(): void;
  disable(): void;
  kick(): void;
}

export function createStreamClient(
  label: string,
  transport: StreamTransport,
  events: StreamEvents,
): StreamClient {
  let enabled = false;
  let running: AbortController | null = null;
  let cancelWait: (() => void) | null = null;
  let backoffMs = BACKOFF_MIN_MS;

  function clearWait(): void {
    cancelWait?.();
    cancelWait = null;
  }

  function connect(): void {
    if (!enabled || running !== null) return;
    clearWait();
    const ctl = new AbortController();
    running = ctl;
    void runTracked(`box-link: stream ${label}`, async () => {
      const startedAt = Date.now();
      const end = await attempt(transport, events, ctl.signal);
      if (running === ctl) running = null;
      if (end.kind === "aborted" || !enabled) return;
      if (end.kind === "route-missing") {
        events.routeMissing(end.error);
        return;
      }
      if (end.heardHello) backoffMs = BACKOFF_MIN_MS;
      events.failed({ error: end.error, answered: end.answered, startedAt });
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      cancelWait = armAwakeDeadline(wait, () => {
        cancelWait = null;
        connect();
      });
    });
  }

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      backoffMs = BACKOFF_MIN_MS;
      connect();
    },
    disable() {
      enabled = false;
      clearWait();
      running?.abort();
      running = null;
    },
    kick() {
      if (!enabled) return;
      backoffMs = BACKOFF_MIN_MS;
      connect();
    },
  };
}
