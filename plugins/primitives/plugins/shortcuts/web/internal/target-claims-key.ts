import type { ParsedCombo } from "./types";

/** Keys a range input moves its thumb with. */
const RANGE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const ACTIVATE_KEYS = new Set([" ", "Enter"]);
const RADIO_KEYS = new Set([
  " ",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

/**
 * The keys each NON-text input type acts on natively. Every other input type
 * takes text, and so claims every key. A range slider claims its arrows but not
 * Space — so after dragging a volume fader, Space still plays / pauses instead
 * of falling through to the browser's page scroll.
 */
const CONTROL_INPUT_KEYS: Record<string, ReadonlySet<string>> = {
  range: RANGE_KEYS,
  checkbox: new Set([" "]),
  radio: RADIO_KEYS,
  button: ACTIVATE_KEYS,
  submit: ACTIVATE_KEYS,
  reset: ACTIVATE_KEYS,
  image: ACTIVATE_KEYS,
  file: ACTIVATE_KEYS,
  color: ACTIVATE_KEYS,
};

/**
 * Does the event's target act on THIS key natively (typing it into a text
 * field, moving a slider's thumb, ticking a checkbox)?
 *
 * When true, plain-key shortcuts must yield so the key reaches the element —
 * pressing space in a prompt editor should insert a space, not toggle playback.
 * The answer depends on the key: a focused slider owns the arrows, not Space.
 */
export function targetClaimsKey(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const keys = CONTROL_INPUT_KEYS[target.type];
    return keys === undefined || keys.has(event.key);
  }
  return false;
}

/**
 * Is this combo a deliberate command rather than typing? A non-shift modifier
 * (Cmd/Ctrl/Alt — e.g. Cmd+K, Cmd+Enter), or a function key (F1–F24), which
 * never inserts text. Such combos still fire while a field has focus. Shift
 * alone is not a modifier here — shift+key is still typing.
 */
export function comboIsCommand(combo: ParsedCombo): boolean {
  return combo.mod || combo.ctrl || combo.alt || /^f\d{1,2}$/.test(combo.key);
}
