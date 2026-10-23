import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { stepReveal } from "./reveal-pace";
import {
  clearTail,
  FADE_MS,
  paintTail,
  TIER_COUNT,
  type RevealTone,
} from "./reveal-tail";
import "./stream-tail.css";

/** A reveal moment: `len` characters were shown from time `t` on. */
interface Mark {
  t: number;
  len: number;
}

/**
 * How much of `text` — the message being written, still growing — to show
 * now: a steady flow over the bursts it arrives in (`stepReveal`), with its
 * newest words fading in on `container` (`paintTail`). Driven by animation
 * frames only while there is text left to reveal or a fade still running.
 * Reduced motion shows the text as it arrives. `tone` is the colour the
 * container's text settles on, which the newest words fade up to.
 */
export function useSteadyReveal(
  text: string,
  container: RefObject<HTMLElement | null>,
  tone: RevealTone = "foreground",
): number {
  const [reduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [shown, setShown] = useState(0);
  const textRef = useRef(text);
  const wakeRef = useRef<(() => void) | null>(null);
  const paintRef = useRef<((now: number, len: number) => void) | null>(null);

  useEffect(() => {
    if (reduced) return;
    const key = Symbol("streaming-text");
    let revealed = 0;
    let budget = 0;
    let last = 0;
    let frame = 0;
    // Reveal moments within the fade window, oldest first; `floor` is the
    // length revealed before the oldest of them.
    const marks: Mark[] = [];
    let floor = 0;
    const lenAt = (t: number) => {
      let len = floor;
      for (const m of marks) if (m.t <= t) len = m.len;
      return len;
    };
    // What the DOM holds is what React last committed — the paint reads that.
    let committed = 0;
    const paint = (now: number) => {
      const el = container.current;
      if (!el) return;
      const counts: number[] = [];
      let upper = committed;
      for (let tier = 1; tier <= TIER_COUNT; tier++) {
        const lower = Math.min(
          upper,
          lenAt(now - (FADE_MS * tier) / TIER_COUNT),
        );
        counts.push(upper - lower);
        upper = lower;
      }
      paintTail(key, tone, el, counts);
    };
    paintRef.current = (now, len) => {
      committed = len;
      paint(now);
    };
    const tick = (now: number) => {
      const step = stepReveal(
        textRef.current,
        revealed,
        budget,
        (now - last) / 1000,
      );
      last = now;
      budget = step.budget;
      if (step.revealed !== revealed) {
        revealed = step.revealed;
        marks.push({ t: now, len: revealed });
        setShown(revealed);
      }
      while (marks.length > 0 && now - marks[0]!.t > FADE_MS)
        floor = marks.shift()!.len;
      paint(now);
      if (revealed < textRef.current.length || marks.length > 0) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
        clearTail(key);
      }
    };
    wakeRef.current = () => {
      if (frame !== 0) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wakeRef.current();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      wakeRef.current = null;
      paintRef.current = null;
      clearTail(key);
    };
  }, [container, reduced, tone]);

  useEffect(() => {
    textRef.current = text;
    wakeRef.current?.();
  }, [text]);

  // Repaint as soon as a reveal commits, so the new words are faint from their
  // first frame rather than drawn at full colour for one.
  useLayoutEffect(() => {
    paintRef.current?.(performance.now(), Math.min(shown, text.length));
  }, [shown, text.length]);

  return reduced ? text.length : Math.min(shown, text.length);
}
