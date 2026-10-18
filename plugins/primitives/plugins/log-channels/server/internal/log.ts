import { createChannel } from "./registry";
import type { LogChannel, LogStream } from "./registry";
import { LogPersistence, type DurableLogChannel } from "./persistence";

export type { LogChannel, LogStream };

// Every durable channel declared so far, in declaration order — what the
// host's persistence declares its stores from at boot
// (`declaredDurableChannels`).
const durableChannels: DurableLogChannel[] = [];

/**
 * Declare a DURABLE log channel: registers the channel AND its durable store,
 * the host's (`LogPersistence` — on the desktop a bounded-append file sink,
 * 128 MB × 3 rotation, true by construction). This is the ONLY way to get a
 * persisted channel — there is no `persist` flag. The channel is registered
 * exactly once here (a duplicate id throws), so a channel written from two
 * modules must share ONE `defineLogSink` call.
 *
 * The declaration is recorded at import — so the host's persistence can
 * declare its store (the desktop lists it in `getFileSinks()`, with its
 * description, before it has written a line) — but the store itself resolves
 * LAZILY on first publish: it is a host service, read only inside the booted
 * graph, and on the desktop its path asks for this process's runtime
 * namespace, which must not run at module import (this barrel is imported
 * inside the import-safe @plugins/database/server graph).
 */
export function defineLogSink(spec: {
  id: string;
  description: string;
}): LogChannel {
  const channel = createChannel(spec.id, () =>
    LogPersistence.get().sinkFor(spec),
  );
  durableChannels.push(spec);
  return channel;
}

/** Every durable channel declared so far (`defineLogSink`), in declaration
 *  order — for the host's persistence to declare its stores up front. */
export function declaredDurableChannels(): readonly DurableLogChannel[] {
  return durableChannels;
}

export const Log = {
  /** Declare an EPHEMERAL log channel (in-memory ring buffer only, no disk). */
  channel(id: string): LogChannel {
    return createChannel(id);
  },
};
