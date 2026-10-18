import type {
  LogPersistenceImpl,
  LogSink,
} from "@plugins/primitives/plugins/log-channels/server";

// A durable channel's lines go nowhere past the channel's own ring buffer,
// which the live tail already reads: this host has no disk to keep them on.
const ringOnly: LogSink = { appendAll() {} };

export const memoryPersistence: LogPersistenceImpl = {
  sinkFor: () => ringOnly,
  clientSinkFor: () => ringOnly,
  clientIngressPaused: () => false,
};
