import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/** One line as the channel stamped it, as a sink receives it. */
export interface LogLine {
  t: number;
  stream: "stdout" | "stderr";
  line: string;
}

/**
 * Where one channel's lines go to last: one append per batch, in order. The
 * sink gets the lines, not a wire format: how a line is stored (the desktop's
 * `{t,stream,line}` JSONL envelope) is the store's, as is the read path that
 * parses it back.
 */
export interface LogSink {
  appendAll(lines: readonly LogLine[]): void;
}

/** A durable channel as `defineLogSink` declared it. */
export interface DurableLogChannel {
  id: string;
  description: string;
}

/**
 * How this host keeps log lines past the in-memory ring. The channel registry,
 * the envelope format and the live tail are portable; durability is the
 * host's. The desktop's provider (`log-channels#machine`) appends to
 * `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl` through bounded,
 * rotating file sinks; a host without a filesystem keeps memory only.
 */
export interface LogPersistenceImpl {
  /** The store behind a declared durable channel — asked on its first
   *  publish, once per channel. */
  sinkFor(channel: DurableLogChannel): LogSink;
  /** The store behind one browser-supplied `clientLog` channel. */
  clientSinkFor(channelId: string): LogSink;
  /**
   * Whether the browser's log ingress should refuse batches right now — the
   * host asking observability to back off (the desktop's duress latch). The
   * refused batch is re-queued by the browser, never lost.
   */
  clientIngressPaused(): boolean;
}

export const LogPersistence = defineHostService<LogPersistenceImpl>(
  "log-channels.persistence",
);
