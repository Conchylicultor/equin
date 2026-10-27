import { useEffect, useState, type SyntheticEvent } from "react";
import {
  probeUrlStatus,
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type { Size } from "../../core";

/**
 * Why an image did not load.
 *
 * - `probing` — it failed; the server is being asked why.
 * - `gone` — the server says the file is not there (404, or 410: an
 *   attachment whose file left the disk). Nothing to retry.
 * - `unreadable` — anything else: offline, a 5xx, a refusal, bytes that are
 *   not an image. Worth a retry.
 */
export type ImageFailure = "probing" | "gone" | "unreadable";

export type ImageLoad =
  | { kind: "pending" }
  | { kind: "loaded"; size: Size }
  | { kind: "failed"; reason: ImageFailure };

export interface ImageLoadState {
  load: ImageLoad;
  /** The `<img>`'s `key`: a retry remounts it, so it loads again. */
  imgKey: number;
  /** Spread onto the `<img>`. */
  imgProps: {
    onLoad: (e: SyntheticEvent<HTMLImageElement>) => void;
    onError: () => void;
  };
  /** Load the image again. */
  retry: () => void;
}

interface State {
  src: string;
  attempt: number;
  load: ImageLoad;
}

const PENDING: ImageLoad = { kind: "pending" };

/** A 404 or 410 means the file itself is gone. */
const GONE_STATUSES = new Set([404, 410]);

async function failureOf(
  transport: Transport,
  src: string,
): Promise<"gone" | "unreadable"> {
  // A data: / blob: URI has no server to ask: it failed on its own bytes.
  if (src.startsWith("data:") || src.startsWith("blob:")) return "unreadable";
  const answer = await probeUrlStatus(transport, src);
  return answer.kind === "status" && GONE_STATUSES.has(answer.status)
    ? "gone"
    : "unreadable";
}

/**
 * The load state of one `<img>`: pending, loaded with its natural size, or
 * failed with a reason. An `<img>`'s error event cannot say why it failed, so
 * on failure the source is asked once for its status.
 *
 * A new `src` starts over at `pending`; an answer about an older `src` or an
 * older attempt is dropped.
 */
export function useImageLoad(src: string): ImageLoadState {
  const transport = useTransport();
  const [state, setState] = useState<State>({ src, attempt: 0, load: PENDING });
  // Derived, not synced in an effect: a new src is pending from its first render.
  const current: State =
    state.src === src ? state : { src, attempt: 0, load: PENDING };
  const { attempt } = current;

  const settle = (load: ImageLoad) =>
    setState((s) =>
      (s.src === src ? s.attempt : 0) === attempt ? { src, attempt, load } : s,
    );

  return {
    load: current.load,
    imgKey: attempt,
    imgProps: {
      onLoad: (e) =>
        settle({
          kind: "loaded",
          size: {
            width: e.currentTarget.naturalWidth,
            height: e.currentTarget.naturalHeight,
          },
        }),
      onError: () => {
        settle({ kind: "failed", reason: "probing" });
        void failureOf(transport, src).then((reason) =>
          settle({ kind: "failed", reason }),
        );
      },
    },
    retry: () => setState({ src, attempt: attempt + 1, load: PENDING }),
  };
}

export interface ImageProbeState {
  load: ImageLoad;
  /** Load the image again. */
  retry: () => void;
}

/**
 * `useImageLoad` for an image that is not on the page yet: loads `src`
 * off-DOM and answers with the same states, failures classified the same way.
 * For a caller that must know the outcome before it chooses what to render —
 * an image diff deciding between added, deleted and side by side.
 */
export function useImageProbe(src: string): ImageProbeState {
  const transport = useTransport();
  const [state, setState] = useState<State>({ src, attempt: 0, load: PENDING });
  // Derived, not synced in an effect: a new src is pending from its first render.
  const current: State =
    state.src === src ? state : { src, attempt: 0, load: PENDING };
  const { attempt } = current;

  useEffect(() => {
    let live = true;
    const settle = (load: ImageLoad) => {
      if (live) setState({ src, attempt, load });
    };
    const img = new Image();
    img.onload = () =>
      settle({
        kind: "loaded",
        size: { width: img.naturalWidth, height: img.naturalHeight },
      });
    img.onerror = () => {
      settle({ kind: "failed", reason: "probing" });
      void failureOf(transport, src).then((reason) =>
        settle({ kind: "failed", reason }),
      );
    };
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
      img.onerror = null;
    };
  }, [transport, src, attempt]);

  return {
    load: current.load,
    retry: () => setState({ src, attempt: attempt + 1, load: PENDING }),
  };
}
