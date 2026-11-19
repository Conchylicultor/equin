import { describe, expect, test } from "bun:test";
import { speechSupport } from "./speech-support";

type Spoken = { text: string; rate: number; pitch: number };

function fakeWindow(parts: { synth?: boolean; utterance?: boolean }): {
  win: Window;
  spoken: Spoken[];
  cancels: () => number;
} {
  const spoken: Spoken[] = [];
  let cancels = 0;
  class Utterance {
    rate = 1;
    pitch = 1;
    constructor(readonly text: string) {}
  }
  const win: Record<string, unknown> = {};
  if (parts.synth)
    win.speechSynthesis = {
      speak: (u: Utterance) =>
        spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch }),
      cancel: () => {
        cancels += 1;
      },
    };
  if (parts.utterance) win.SpeechSynthesisUtterance = Utterance;
  return { win: win as unknown as Window, spoken, cancels: () => cancels };
}

describe("speechSupport", () => {
  test("unsupported where the window has no speechSynthesis", () => {
    const { win } = fakeWindow({ utterance: true });
    expect(speechSupport(win).kind).toBe("unsupported");
  });

  test("unsupported where the window has no SpeechSynthesisUtterance", () => {
    const { win } = fakeWindow({ synth: true });
    expect(speechSupport(win).kind).toBe("unsupported");
  });

  test("unsupported without a window", () => {
    expect(speechSupport(undefined).kind).toBe("unsupported");
  });

  test("speaks and cancels through the window's API", () => {
    const { win, spoken, cancels } = fakeWindow({
      synth: true,
      utterance: true,
    });
    const support = speechSupport(win);
    if (support.kind !== "supported") throw new Error("expected supported");
    support.cancel();
    support.speak("A! Apple", { rate: 0.9, pitch: 1.35 });
    expect(spoken).toEqual([{ text: "A! Apple", rate: 0.9, pitch: 1.35 }]);
    expect(cancels()).toBe(1);
  });

  test("one answer per window", () => {
    const { win } = fakeWindow({ synth: true, utterance: true });
    expect(speechSupport(win)).toBe(speechSupport(win));
  });
});
