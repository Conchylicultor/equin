import { join } from "node:path";
import {
  defineFileSink,
  sanitizeChannel,
} from "@plugins/infra/plugins/file-sink/core";
import { createChannel } from "./registry";
import type { LogChannel, LogStream } from "./registry";
import { logsDir } from "./persist";

export type { LogChannel, LogStream };

/**
 * Declare a DURABLE log channel: registers the channel AND (on its first publish)
 * its bounded-append file sink (128 MB × 3 rotation, true by construction). This
 * is the ONLY way to get a persisted channel — there is no `persist` flag. The
 * channel is registered exactly once here (a duplicate id throws), so a channel
 * written from two modules must share ONE `defineLogSink` call.
 *
 * The file sink is built LAZILY on first publish: its path resolution asks for
 * this process's runtime namespace, which must not run at module import (this barrel is
 * imported inside the import-safe @plugins/database/server graph). The on-disk
 * file is `<logsDir>/<id>.jsonl`; the id must match what the read path
 * (`readChannelEntries`) reconstructs, so both derive the filename through
 * `sanitizeChannel`.
 */
export function defineLogSink(spec: {
  id: string;
  description: string;
}): LogChannel {
  return createChannel(spec.id, () =>
    defineFileSink({
      id: spec.id,
      description: spec.description,
      path: join(logsDir(), sanitizeChannel(spec.id) + ".jsonl"),
    }),
  );
}

export const Log = {
  /** Declare an EPHEMERAL log channel (in-memory ring buffer only, no disk). */
  channel(id: string): LogChannel {
    return createChannel(id);
  },
};
