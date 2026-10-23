/**
 * What each key does, as data: `classifyKey` maps a `KeyboardEvent.key` to the
 * one effect it plays. Pure, so the mapping is testable and every surface that
 * plays the party (the stage, a tap on a touchscreen) shares it.
 */

/** A letter's picture and the word it stands for ("A" → 🍎 Apple). */
export interface LetterWord {
  readonly emoji: string;
  readonly word: string;
}

export const LETTER_WORDS: Readonly<Record<string, LetterWord>> = {
  A: { emoji: "🍎", word: "Apple" },
  B: { emoji: "🐻", word: "Bear" },
  C: { emoji: "🐱", word: "Cat" },
  D: { emoji: "🐶", word: "Dog" },
  E: { emoji: "🐘", word: "Elephant" },
  F: { emoji: "🐸", word: "Frog" },
  G: { emoji: "🦒", word: "Giraffe" },
  H: { emoji: "🐴", word: "Horse" },
  I: { emoji: "🍦", word: "Ice cream" },
  J: { emoji: "🪼", word: "Jellyfish" },
  K: { emoji: "🪁", word: "Kite" },
  L: { emoji: "🦁", word: "Lion" },
  M: { emoji: "🐵", word: "Monkey" },
  N: { emoji: "🪺", word: "Nest" },
  O: { emoji: "🐙", word: "Octopus" },
  P: { emoji: "🐧", word: "Penguin" },
  Q: { emoji: "👑", word: "Queen" },
  R: { emoji: "🌈", word: "Rainbow" },
  S: { emoji: "⭐", word: "Star" },
  T: { emoji: "🐢", word: "Turtle" },
  U: { emoji: "☂️", word: "Umbrella" },
  V: { emoji: "🌋", word: "Volcano" },
  W: { emoji: "🐳", word: "Whale" },
  X: { emoji: "🎶", word: "Xylophone" },
  Y: { emoji: "🪀", word: "Yo-yo" },
  Z: { emoji: "🦓", word: "Zebra" },
};

/** What a digit counts, indexed by the digit (0 is one big donut). */
export const COUNT_PICTURES = [
  "🍩",
  "🎈",
  "🐞",
  "🍓",
  "🐥",
  "🌼",
  "🐟",
  "🧁",
  "🦋",
  "🍪",
] as const;

export const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
] as const;

/** How a letter enters, picked by its index so each letter keeps its own. */
export const ENTRANCES = [
  "pop",
  "spin",
  "bounce",
  "wobble",
  "zoom",
  "jelly",
] as const;
export type Entrance = (typeof ENTRANCES)[number];

/** Which synthesized instrument a letter plays, picked by its index. */
export const INSTRUMENTS = ["bell", "pluck", "marimba", "chirp"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export type Direction = "up" | "down" | "left" | "right";
export type Modifier =
  "Shift" | "Control" | "Alt" | "Meta" | "Tab" | "CapsLock";

export type KeyEffect =
  | {
      readonly kind: "letter";
      readonly letter: string;
      /** 0 for A … 25 for Z: picks the hue, note, instrument and entrance. */
      readonly index: number;
    }
  | { readonly kind: "digit"; readonly digit: number }
  | { readonly kind: "fireworks" }
  | { readonly kind: "rainbow" }
  | { readonly kind: "flier"; readonly direction: Direction }
  | { readonly kind: "sweep" }
  | { readonly kind: "boing"; readonly modifier: Modifier }
  /** Any other key: confetti seeded by the key, so each key keeps its own. */
  | { readonly kind: "confetti"; readonly key: string; readonly seed: number };

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const MODIFIERS: readonly string[] = [
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Tab",
  "CapsLock",
] satisfies Modifier[];
const SWEEPS: readonly string[] = ["Backspace", "Delete", "Escape"];

/** A stable small number for a key name — the same key always the same. */
export function keySeed(key: string): number {
  let seed = 0;
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) % 100_003;
  return seed;
}

/**
 * The effect a key plays. `key` is `KeyboardEvent.key`; `code` (the physical
 * key) seeds the confetti of a key whose `key` is not a printable character,
 * so "F5" and "PageDown" still differ.
 */
export function classifyKey(key: string, code = key): KeyEffect {
  if (/^[a-z]$/i.test(key)) {
    const letter = key.toUpperCase();
    return { kind: "letter", letter, index: letter.charCodeAt(0) - 65 };
  }
  if (/^[0-9]$/.test(key)) return { kind: "digit", digit: Number(key) };
  if (key === " ") return { kind: "fireworks" };
  if (key === "Enter") return { kind: "rainbow" };
  const direction = ARROWS[key];
  if (direction) return { kind: "flier", direction };
  if (SWEEPS.includes(key)) return { kind: "sweep" };
  if (MODIFIERS.includes(key))
    return { kind: "boing", modifier: key as Modifier };
  const name = key.length === 1 ? key : code;
  return { kind: "confetti", key: name, seed: keySeed(name) };
}

/** The bead a key leaves on the trail, or null for a key that leaves none. */
export function beadLabel(effect: KeyEffect): string | null {
  switch (effect.kind) {
    case "letter":
      return effect.letter;
    case "digit":
      return String(effect.digit);
    case "fireworks":
      return "␣";
    case "rainbow":
      return "⏎";
    case "flier":
      return { up: "↑", down: "↓", left: "←", right: "→" }[effect.direction];
    case "confetti":
      return effect.key.length === 1 ? effect.key : null;
    case "sweep":
    case "boing":
      return null;
  }
}

/** C-major pentatonic, so mashing any keys still sounds like a tune. */
const PENTATONIC = [0, 2, 4, 7, 9];

/** The frequency of the `step`-th pentatonic note above middle C. */
export function pentatonicHz(step: number): number {
  const octave = Math.floor(step / PENTATONIC.length);
  const degree = PENTATONIC[step % PENTATONIC.length] ?? 0;
  return 261.63 * Math.pow(2, (octave * 12 + degree) / 12);
}

/** A hue spread evenly around the wheel for the `i`-th of `n`. */
export function hueOf(i: number, n: number): number {
  return Math.round((i * 360) / n + 330) % 360;
}
