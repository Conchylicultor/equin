/**
 * One upload in flight: the files a client picked for a page's file chooser,
 * streamed in as binary socket messages and written to the page's uploads
 * directory, then handed to the chooser by path. Chromium reads a picked
 * `File` from its path lazily (when the page reads or submits it), so the
 * files stay until their page closes (`removeUploads`).
 */
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { FileChooser } from "playwright";
import { UPLOAD_CHUNK_BYTES } from "../core";
import { browserEngineUploadsDir } from "../data-dirs";

export interface UploadFile {
  name: string;
  size: number;
}

/** A file name the client sent, as one safe path segment. */
function safeName(name: string): string {
  const base = name.replace(/[/\\\0]/g, "_");
  return base === "." || base === ".." ? "file" : base;
}

/** A fresh directory for one page's uploads (a host-minted name, never the client's). */
export function uploadsDirFor(): string {
  return browserEngineUploadsDir.file(crypto.randomUUID());
}

/** Remove a page's uploads (its page closed). */
export async function removeUploads(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export class Upload {
  readonly total: number;
  private received = 0;
  private index = 0;
  /** Bytes of the current file written so far. */
  private written = 0;
  private handle: FileHandle | null = null;
  private readonly paths: string[];

  private constructor(
    private readonly chooser: FileChooser,
    private readonly files: UploadFile[],
    dir: string,
  ) {
    this.total = files.reduce((n, f) => n + f.size, 0);
    // One subdirectory per upload, so two picks of one name never collide.
    const into = join(dir, crypto.randomUUID());
    this.paths = files.map((f) => join(into, safeName(f.name)));
  }

  static async start(
    chooser: FileChooser,
    files: UploadFile[],
    dir: string,
  ): Promise<Upload> {
    const upload = new Upload(chooser, files, dir);
    const first = upload.paths[0];
    if (first === undefined) throw new Error("an upload of no files");
    await mkdir(join(first, ".."), { recursive: true });
    await upload.openCurrent();
    return upload;
  }

  /** Whether every byte arrived and the chooser has the files. */
  get done(): boolean {
    return this.index >= this.files.length;
  }

  get progress(): { received: number; total: number } {
    return { received: this.received, total: this.total };
  }

  /**
   * Open the current file, passing over empty ones (written as they are) —
   * and, past the last, hand every file to the chooser.
   */
  private async openCurrent(): Promise<void> {
    for (;;) {
      const file = this.files[this.index];
      const path = this.paths[this.index];
      if (file === undefined || path === undefined) {
        await this.chooser.setFiles(this.paths);
        return;
      }
      this.handle = await open(path, "w");
      this.written = 0;
      if (file.size > 0) return;
      await this.handle.close();
      this.handle = null;
      this.index++;
    }
  }

  /** Write one chunk of the current file. */
  async write(chunk: Uint8Array): Promise<void> {
    const file = this.files[this.index];
    const handle = this.handle;
    if (file === undefined || handle === null) {
      throw new Error("upload bytes past the files announced");
    }
    if (chunk.byteLength > UPLOAD_CHUNK_BYTES) {
      throw new Error(`an upload chunk over ${UPLOAD_CHUNK_BYTES} bytes`);
    }
    if (this.written + chunk.byteLength > file.size) {
      throw new Error(`more bytes than ${file.name}'s ${file.size}`);
    }
    await handle.write(chunk);
    this.written += chunk.byteLength;
    this.received += chunk.byteLength;
    if (this.written < file.size) return;
    await handle.close();
    this.handle = null;
    this.index++;
    await this.openCurrent();
  }

  /** The socket went mid-upload: close the open file (the page's dir goes with the page). */
  async abort(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.index = this.files.length;
    await handle?.close();
  }
}
