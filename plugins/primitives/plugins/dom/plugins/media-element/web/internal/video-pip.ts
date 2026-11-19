// ── A video's own picture in picture, only where it exists ─────────────────
//
// `HTMLVideoElement.requestPictureInPicture` is missing on Firefox (before
// 153), disabled where `document.pictureInPictureEnabled` is false, and, where
// it exists, still a request the browser may refuse with a DOMException: no
// user gesture, a video not ready yet or one this browser cannot float (iOS
// Safari answers NotSupportedError / InvalidStateError / NotAllowedError). The
// request is reachable only through `videoPipSupport(doc)`, whose `supported`
// arm answers a refusal as a value — so no caller leaves one unhandled. The
// `media-element/no-raw-request-picture-in-picture` lint rule sends every
// other `.requestPictureInPicture()` call here.

/** What the browser answered a picture-in-picture request. */
export type VideoPipOutcome =
  | { kind: "entered" }
  /** The browser said no (the DOMException names why). */
  | { kind: "refused"; error: DOMException };

/** What this document can do about a video's own picture in picture. */
export type VideoPipSupport =
  | { kind: "unsupported" }
  | {
      kind: "supported";
      /** Asks the browser to float `video`; a DOMException is a refusal, anything else throws. */
      request: (video: HTMLVideoElement) => Promise<VideoPipOutcome>;
    };

const UNSUPPORTED: VideoPipSupport = { kind: "unsupported" };

async function request(video: HTMLVideoElement): Promise<VideoPipOutcome> {
  if (typeof video.requestPictureInPicture === "function") {
    try {
      await video.requestPictureInPicture();
      return { kind: "entered" };
    } catch (err) {
      if (err instanceof DOMException) return { kind: "refused", error: err };
      throw err;
    }
  }
  // videoPipSupport answered supported only where the method exists.
  throw new Error(
    "videoPipSupport: supported, yet this video has no requestPictureInPicture",
  );
}

const SUPPORTED: VideoPipSupport = { kind: "supported", request };

/** Whether `doc` (default: this page's) offers a video's own picture in picture, and how to ask. */
export function videoPipSupport(doc: Document = document): VideoPipSupport {
  const proto = doc.defaultView?.HTMLVideoElement?.prototype;
  if (
    doc.pictureInPictureEnabled !== true ||
    proto === undefined ||
    typeof proto.requestPictureInPicture !== "function"
  )
    return UNSUPPORTED;
  return SUPPORTED;
}
