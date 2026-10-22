import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { PartialMessage } from "../../core";
import {
  AgentNotRunningError,
  helloAgent,
  subscribeAgent,
  type PartialSubscription,
} from "./socket-client";

// The partial message of each watched conversation, held from the agent's
// `subscribe` stream. A connection is open only while someone watches (the
// live value's `whileSubscribed`, refcounted per conversation by the live
// runtime). No polling: an agent that is not running yet, or that exited, is
// connected to again when the events consumer sees it become ready.
//
// A stream that breaks (a refused subscribe, a line that does not parse) is a
// report and no partial text — never a throw: this runs in socket callbacks,
// where a throw would take the whole backend down for a cosmetic stream. The
// finished message still arrives through the transcript.

/** File a broken stream as a crash report (loud, but not fatal). */
function reportBroken(id: string, err: Error): void {
  void recordReport({
    kind: "crash",
    source: "server-caught",
    message: `SDK agent ${id}: its partial-message stream broke, so the reply shows only once finished — ${err.message}`,
    data: {
      errorType: "SdkPartialStreamBroken",
      label: "runtime-sdk.partial-stream",
      stack: err.stack ?? null,
    },
  });
}

interface Watch {
  onChange: (message: PartialMessage | null) => void;
  subscription: PartialSubscription | null;
  /** A connect is in flight: a second trigger must not open a second one. */
  connecting: boolean;
  /** The agent became ready during that connect: try again once it settles. */
  again: boolean;
  stopped: boolean;
}

const watches = new Map<string, Watch>();

async function connect(id: string, watch: Watch): Promise<void> {
  if (watch.subscription || watch.stopped) return;
  if (watch.connecting) {
    watch.again = true;
    return;
  }
  watch.connecting = true;
  watch.again = false;
  try {
    // An agent started before streaming existed answers without `stream`: it
    // has nothing to stream until its next start (which reconnects here).
    const hello = await helloAgent(id);
    if (!hello.stream || watch.stopped) return;
    let closed = false;
    const subscription = await subscribeAgent(
      id,
      (message) => {
        if (!watch.stopped) watch.onChange(message);
      },
      (broken) => {
        closed = true;
        watch.subscription = null;
        if (broken) reportBroken(id, broken);
        if (!watch.stopped) watch.onChange(null);
      },
    );
    if (watch.stopped) subscription.close();
    else if (!closed) watch.subscription = subscription;
  } catch (err) {
    // Not running: nothing streams; its next start reconnects.
    if (!(err instanceof AgentNotRunningError))
      reportBroken(id, err instanceof Error ? err : new Error(String(err)));
  } finally {
    watch.connecting = false;
  }
  if (watch.again) await connect(id, watch);
}

/**
 * Hear `id`'s partial message (null when none is being written) until the
 * returned stop. One watcher per conversation: the live runtime refcounts
 * readers above this.
 */
export function watchPartialMessage(
  id: string,
  onChange: (message: PartialMessage | null) => void,
): () => void {
  if (watches.has(id))
    throw new Error(
      `runtime-sdk: the partial message of ${id} is already watched`,
    );
  const watch: Watch = {
    onChange,
    subscription: null,
    connecting: false,
    again: false,
    stopped: false,
  };
  watches.set(id, watch);
  void connect(id, watch);
  return () => {
    watch.stopped = true;
    watches.delete(id);
    watch.subscription?.close();
  };
}

/** The agent of `id` (re)started and is ready: connect a watched conversation. */
export function agentReady(id: string): void {
  const watch = watches.get(id);
  if (watch) void connect(id, watch);
}
