import {
  UPLOAD_CHUNK_BYTES,
  type ClientMessage,
} from "@plugins/apps/plugins/browser/plugins/engine/core";

/** Chunks sent ahead of the host's acks: enough to keep the socket busy, never a queue of megabytes. */
const IN_FLIGHT = 4;

interface Chunk {
  file: File;
  start: number;
  end: number;
}

/**
 * The client half of an upload: the `files` announcement, then each file's
 * bytes as binary messages of at most `UPLOAD_CHUNK_BYTES`, in order. Paced
 * by the host's `upload` acks — the first answers the announcement, each later
 * one a chunk written — so at most {@link IN_FLIGHT} chunks are ever unacked.
 */
export class UploadSender {
  private readonly chunks: Chunk[] = [];
  private next = 0;
  private inFlight = 0;
  private announced = false;
  /** Chunks are read asynchronously but must leave in order. */
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly files: File[],
    private readonly send: (data: string | ArrayBuffer) => void,
  ) {
    for (const file of files) {
      for (let start = 0; start < file.size; start += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(file.size, start + UPLOAD_CHUNK_BYTES);
        this.chunks.push({ file, start, end });
      }
    }
  }

  /** The message that answers the page's chooser. */
  announcement(): ClientMessage {
    return {
      t: "files",
      files: this.files.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.size,
      })),
    };
  }

  /** The host acked the announcement or a chunk: send what the window allows. */
  onAck(): void {
    if (this.announced) this.inFlight--;
    this.announced = true;
    while (this.inFlight < IN_FLIGHT && this.next < this.chunks.length) {
      const chunk = this.chunks[this.next++];
      if (!chunk) break;
      this.inFlight++;
      this.sending = this.sending.then(async () => {
        const bytes = await chunk.file
          .slice(chunk.start, chunk.end)
          .arrayBuffer();
        this.send(bytes);
      });
    }
  }
}
