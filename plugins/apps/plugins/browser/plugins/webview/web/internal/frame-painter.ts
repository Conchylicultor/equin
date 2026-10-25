/**
 * Paints the engine's JPEG screencast frames onto a canvas, latest-wins: a
 * frame arriving while another decodes replaces any frame still waiting, so a
 * slow decode never builds a queue of stale frames. Decoding
 * (`createImageBitmap`) runs as soon as a frame lands; drawing waits for the
 * next animation frame. The last bitmap is kept so a resized canvas (whose
 * backing store a resize clears) is repainted at once.
 */
export class FramePainter {
  private waiting: ArrayBuffer | null = null;
  private decoding = false;
  private bitmap: ImageBitmap | null = null;
  private raf: number | null = null;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** A frame arrived. */
  push(frame: ArrayBuffer): void {
    this.waiting = frame;
    if (!this.decoding) void this.decodeNext();
  }

  /** Redraw the last frame (after the canvas's backing store was resized). */
  repaint(): void {
    this.scheduleDraw();
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.bitmap?.close();
    this.bitmap = null;
    this.waiting = null;
  }

  private async decodeNext(): Promise<void> {
    const frame = this.waiting;
    if (!frame || this.disposed) return;
    this.waiting = null;
    this.decoding = true;
    try {
      const bitmap = await createImageBitmap(
        new Blob([frame], { type: "image/jpeg" }),
      );
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.bitmap?.close();
      this.bitmap = bitmap;
      this.scheduleDraw();
    } finally {
      this.decoding = false;
    }
    if (this.waiting) await this.decodeNext();
  }

  private scheduleDraw(): void {
    if (this.raf !== null || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  private draw(): void {
    const { bitmap, canvas } = this;
    if (!bitmap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("FramePainter: the canvas has no 2d context");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
}
