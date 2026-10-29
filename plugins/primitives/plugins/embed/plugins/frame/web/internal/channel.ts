import {
  FRAME_PROTOCOL,
  FRAME_REPLY_VALUES,
  FrameMessageSchema,
  type FrameHeights,
  type FrameOp,
  type FrameReplyValue,
  type FrameRequest,
} from "@plugins/primitives/plugins/embed/plugins/frame/plugins/agent/core";

/** How long a request waits for the frame's agent before it fails, loudly. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A request the frame's agent did not answer, or answered with an error. */
export class FrameChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameChannelError";
  }
}

/**
 * The channel was closed (its frame was replaced or unmounted) while a request
 * waited: an expected end, which a caller tells apart from a failure.
 */
export class FrameChannelClosedError extends FrameChannelError {
  constructor(op: string) {
    super(`${op}: channel closed`);
    this.name = "FrameChannelClosedError";
  }
}

/**
 * The parent's end of a content frame's channel (`core/protocol.ts`): the one
 * way the app reaches a document served off its origin. Every answer is
 * parsed and bounded — the content can answer in its agent's place, so a
 * reply is data to lay a frame out with, never more.
 */
export interface FrameChannel {
  request<Op extends FrameOp>(
    req: Extract<FrameRequest, { op: Op }>,
  ): Promise<FrameReplyValue<Op>>;
  /** Content height reports (after a `watchHeight` request). */
  onHeight(listener: (heights: FrameHeights) => void): () => void;
  /** The reader moved or typed inside the frame (throttled by the agent). */
  onActivity(listener: () => void): () => void;
  /** Detach: pending requests fail, listeners are dropped. */
  close(): void;
}

/**
 * Hand a just-loaded content frame its port and return the channel. Called
 * from the frame's `load`: a new document is a new agent, so every load is a
 * new channel. `src` is the URL the frame was given — the port is posted to
 * exactly its origin, so a document that navigated elsewhere gets nothing.
 */
export function connectFrame(
  frame: HTMLIFrameElement,
  src: string,
): FrameChannel {
  const target = frame.contentWindow;
  if (!target) throw new FrameChannelError("content frame has no window");
  const origin = new URL(src, window.location.href).origin;
  const { port1, port2 } = new MessageChannel();
  target.postMessage({ protocol: FRAME_PROTOCOL, type: "connect" }, origin, [
    port2,
  ]);

  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    {
      op: FrameOp;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const heightListeners = new Set<(h: FrameHeights) => void>();
  const activityListeners = new Set<() => void>();

  port1.onmessage = (event: MessageEvent) => {
    const parsed = FrameMessageSchema.safeParse(event.data);
    // A message the protocol does not spell is the content talking, not the
    // agent: ignored, never acted on.
    if (!parsed.success) return;
    const msg = parsed.data;
    if ("event" in msg) {
      if (msg.event === "height") {
        for (const l of heightListeners) l(msg.heights);
      } else {
        for (const l of activityListeners) l();
      }
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (!msg.ok) {
      entry.reject(new FrameChannelError(`${entry.op}: ${msg.error}`));
      return;
    }
    const value = FRAME_REPLY_VALUES[entry.op].safeParse(msg.value);
    if (value.success) entry.resolve(value.data);
    else entry.reject(new FrameChannelError(`${entry.op}: malformed reply`));
  };

  return {
    request(req) {
      if (closed) {
        return Promise.reject(new FrameChannelClosedError(req.op));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new FrameChannelError(
              `${req.op}: the content frame did not answer within ${String(REQUEST_TIMEOUT_MS / 1000)} s — is its document served by a content route (with the frame agent)?`,
            ),
          );
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
          op: req.op,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        port1.postMessage({ ...req, id });
      });
    },
    onHeight(listener) {
      heightListeners.add(listener);
      return () => heightListeners.delete(listener);
    },
    onActivity(listener) {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      port1.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new FrameChannelClosedError(entry.op));
      }
      pending.clear();
      heightListeners.clear();
      activityListeners.clear();
    },
  };
}
