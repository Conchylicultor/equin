// ── The browser's speech synthesis, only where it exists ───────────────────
//
// The Web Speech API's `speechSynthesis` global is not on every browser: some
// Android browsers, in-app webviews and privacy-hardened builds have none, and
// a bare `speechSynthesis.cancel()` there throws "speechSynthesis is not
// defined" (equin.ai's Keyboard Party, 2026-11-19). So speaking is reachable
// only through `speechSupport(win)`: its `unsupported` arm carries no `speak`,
// so a caller must branch — and decide what silence means for it.
//
// The `speech-synthesis/no-raw-speech-synthesis` lint rule sends every other
// use of `speechSynthesis` / `SpeechSynthesisUtterance` here.

/** How an utterance sounds; each defaults to the browser's own. */
export type SpeakOptions = {
  /** 0.1–10, 1 is normal speed. */
  rate?: number;
  /** 0–2, 1 is the voice's normal pitch. */
  pitch?: number;
  /** 0–1. */
  volume?: number;
  /** BCP 47 language tag, e.g. "en-US". */
  lang?: string;
};

/** What this window can do about speech synthesis. */
export type SpeechSupport =
  | {
      /** No speech synthesis here (some Android browsers, webviews, hardened builds). */
      kind: "unsupported";
    }
  | {
      kind: "supported";
      /** Queues `text` to be spoken after anything still being said. */
      speak: (text: string, options?: SpeakOptions) => void;
      /** Stops what is being said and drops everything queued. */
      cancel: () => void;
    };

const UNSUPPORTED: SpeechSupport = { kind: "unsupported" };

/** One answer per window, so repeated reads are a stable value. */
const byWindow = new WeakMap<Window, SpeechSupport>();

/** The API as a window may (not) carry it: lib.dom declares both as always there. */
type MaybeSpeechWindow = {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
};

function detect(win: Window): SpeechSupport {
  const { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } =
    win as MaybeSpeechWindow;
  // Both halves: a browser naming one and not the other cannot speak.
  if (
    typeof synth?.speak !== "function" ||
    typeof synth.cancel !== "function" ||
    typeof Utterance !== "function"
  )
    return UNSUPPORTED;
  return {
    kind: "supported",
    speak: (text, options = {}) => {
      const u = new Utterance(text);
      if (options.rate !== undefined) u.rate = options.rate;
      if (options.pitch !== undefined) u.pitch = options.pitch;
      if (options.volume !== undefined) u.volume = options.volume;
      if (options.lang !== undefined) u.lang = options.lang;
      synth.speak(u);
    },
    cancel: () => synth.cancel(),
  };
}

/**
 * Whether `win` (default: this page's window) can speak, and how. A host with
 * no window at all (a static render, a worker) answers `unsupported`.
 */
export function speechSupport(
  win: Window | undefined = typeof window === "undefined" ? undefined : window,
): SpeechSupport {
  if (win === undefined) return UNSUPPORTED;
  let support = byWindow.get(win);
  if (support === undefined) {
    support = detect(win);
    byWindow.set(win, support);
  }
  return support;
}
