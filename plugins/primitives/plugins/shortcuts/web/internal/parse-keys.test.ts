import { expect, test } from "bun:test";
import { matchesEvent, parseCombo } from "./parse-keys";

/** The fields `matchesEvent` reads, off a plain object (no DOM in bun tests). */
function keyEvent(init: {
  key: string;
  code: string;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

test("alt+<letter> matches the physical key when ⌥ composes another character (macOS)", () => {
  const combo = parseCombo("alt+n")!;
  // macOS: ⌥N is the dead key "˜", on the N key.
  expect(
    matchesEvent(combo, keyEvent({ key: "˜", code: "KeyN", altKey: true })),
  ).toBe(true);
  // Elsewhere ⌥N stays "n".
  expect(
    matchesEvent(combo, keyEvent({ key: "n", code: "KeyN", altKey: true })),
  ).toBe(true);
  // Another key composing to "˜" is not N.
  expect(
    matchesEvent(combo, keyEvent({ key: "˜", code: "KeyM", altKey: true })),
  ).toBe(false);
});

test("without alt the physical key is never consulted", () => {
  // An AZERTY "a" sits on the Q key: plain "q" must not fire from it.
  const combo = parseCombo("q")!;
  expect(matchesEvent(combo, keyEvent({ key: "a", code: "KeyQ" }))).toBe(false);
});
