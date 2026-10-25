import type { ClientMessage } from "@plugins/apps/plugins/browser/plugins/engine/core";

/**
 * DOM input → engine wire messages, pure (no DOM globals) so it is unit
 * tested. The viewport calls these from its event handlers.
 */

/** The modifier keys of a DOM keyboard/mouse event. */
export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifiersOf(e: ModifierState): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  );
}

type MouseButton = Extract<ClientMessage, { t: "mouse" }>["button"];

const BUTTONS: readonly MouseButton[] = [
  "left",
  "middle",
  "right",
  "back",
  "forward",
];

/** DOM `MouseEvent.button` → the CDP button name. */
export function mouseButtonOf(button: number): MouseButton {
  return BUTTONS[button] ?? "none";
}

/**
 * The button a CDP `mouseMoved` must name: the one held (from DOM
 * `MouseEvent.buttons`, primary first), else `"none"`. Chromium reads a drag
 * — text selection, HTML5 drag-and-drop, sliders — from the move's `button`,
 * not its `buttons` bitmask: a move naming `"none"` is a hover, whatever is
 * held.
 */
export function heldButtonOf(buttons: number): MouseButton {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  if (buttons & 8) return "back";
  if (buttons & 16) return "forward";
  return "none";
}

/**
 * macOS editing commands per shortcut, the subset of Playwright's
 * `macEditingCommands` (playwright-core/lib/server/macEditingCommands) that a
 * page's text fields need. Chromium on macOS runs these through NSResponder
 * key bindings, which CDP-dispatched keys bypass — so the client names them.
 * Keyed `[Shift+][Control+][Alt+][Meta+]<code>`. `insert*` commands are left
 * out (the key's own text inserts), as Playwright does.
 */
const MAC_EDITING_COMMANDS: Record<string, string | readonly string[]> = {
  Backspace: "deleteBackward",
  Escape: "cancelOperation",
  ArrowUp: "moveUp",
  ArrowDown: "moveDown",
  ArrowLeft: "moveLeft",
  ArrowRight: "moveRight",
  Delete: "deleteForward",
  Home: "scrollToBeginningOfDocument",
  End: "scrollToEndOfDocument",
  PageUp: "scrollPageUp",
  PageDown: "scrollPageDown",
  "Shift+Backspace": "deleteBackward",
  "Shift+ArrowUp": "moveUpAndModifySelection",
  "Shift+ArrowDown": "moveDownAndModifySelection",
  "Shift+ArrowLeft": "moveLeftAndModifySelection",
  "Shift+ArrowRight": "moveRightAndModifySelection",
  "Shift+Delete": "deleteForward",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+End": "moveToEndOfDocumentAndModifySelection",
  "Shift+PageUp": "pageUpAndModifySelection",
  "Shift+PageDown": "pageDownAndModifySelection",
  "Control+KeyA": "moveToBeginningOfParagraph",
  "Control+KeyB": "moveBackward",
  "Control+KeyD": "deleteForward",
  "Control+KeyE": "moveToEndOfParagraph",
  "Control+KeyF": "moveForward",
  "Control+KeyH": "deleteBackward",
  "Control+KeyK": "deleteToEndOfParagraph",
  "Control+KeyN": "moveDown",
  "Control+KeyP": "moveUp",
  "Control+KeyT": "transpose",
  "Control+ArrowLeft": "moveToLeftEndOfLine",
  "Control+ArrowRight": "moveToRightEndOfLine",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection",
  "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Alt+Backspace": "deleteWordBackward",
  "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"],
  "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"],
  "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight",
  "Alt+Delete": "deleteWordForward",
  "Shift+Alt+Backspace": "deleteWordBackward",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection",
  "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection",
  "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection",
  "Shift+Alt+Delete": "deleteWordForward",
  "Meta+Backspace": "deleteToBeginningOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+ArrowLeft": "moveToLeftEndOfLine",
  "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine",
  "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection",
  "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Meta+KeyA": "selectAll",
  "Meta+KeyX": "cut",
  "Meta+KeyZ": "undo",
  "Shift+Meta+KeyZ": "redo",
};

/** The macOS editing commands a key (by `code`) triggers under `e`'s modifiers. */
export function macCommandsFor(code: string, e: ModifierState): string[] {
  const parts: string[] = [];
  if (e.shiftKey) parts.push("Shift");
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  parts.push(code);
  const commands = MAC_EDITING_COMMANDS[parts.join("+")];
  if (commands === undefined) return [];
  return typeof commands === "string" ? [commands] : [...commands];
}

/** The fields of a DOM `KeyboardEvent` the mapping reads. */
export interface KeyEventLike extends ModifierState {
  key: string;
  code: string;
  keyCode: number;
}

/** Keys that insert text without being one printable character. */
const KEY_TEXT: Record<string, string> = { Enter: "\r" };

/** The text a key inserts (`""` for none): a printable key without Ctrl/Meta. */
export function keyText(e: KeyEventLike): string {
  if (e.ctrlKey || e.metaKey) return "";
  if ([...e.key].length === 1) return e.key;
  return KEY_TEXT[e.key] ?? "";
}

/**
 * A keydown / keyup as the `key` message. A keydown that inserts text is
 * `keyDown` carrying it (so the page gets keypress + input); any other is
 * `rawKeyDown`. On macOS the key's editing commands ride along.
 */
export function keyMessage(
  e: KeyEventLike,
  phase: "down" | "up",
  mac: boolean,
): Extract<ClientMessage, { t: "key" }> {
  const text = phase === "down" ? keyText(e) : "";
  const commands = phase === "down" && mac ? macCommandsFor(e.code, e) : [];
  return {
    t: "key",
    type: phase === "up" ? "keyUp" : text !== "" ? "keyDown" : "rawKeyDown",
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    text,
    modifiers: modifiersOf(e),
    ...(commands.length > 0 ? { commands } : {}),
  };
}

/** What the viewport does with a keydown on its focus textarea. */
export type KeyRoute =
  /** Paste: let the browser fire `paste` (→ `insertText`); don't forward the key. */
  | "paste"
  /** Copy / cut: forward the key and ask the page for its selection (`copy`). */
  | "copy"
  /** Forward the key and take it from the app (preventDefault). */
  | "forward"
  /**
   * Forward the key but leave the default alone: an app/browser shortcut
   * (Cmd/Ctrl + a key the page has no editing command for).
   */
  | "forward-shared";

/** Routes a keydown: the clipboard shortcuts are special, other shortcuts are shared. */
export function routeKeyDown(e: KeyEventLike, mac: boolean): KeyRoute {
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (primary && !e.altKey && e.code === "KeyV") return "paste";
  if (primary && !e.altKey && (e.code === "KeyC" || e.code === "KeyX")) {
    return "copy";
  }
  if (e.ctrlKey || e.metaKey) {
    if (mac && macCommandsFor(e.code, e).length > 0) return "forward";
    return "forward-shared";
  }
  return "forward";
}

/** CSS pixels per wheel line / page, to normalize `WheelEvent.deltaMode`. */
const LINE_PX = 16;

/** A wheel delta in CSS pixels (`deltaMode` 0 px, 1 lines, 2 pages). */
export function wheelPixels(
  delta: number,
  deltaMode: number,
  pagePx: number,
): number {
  if (deltaMode === 1) return delta * LINE_PX;
  if (deltaMode === 2) return delta * pagePx;
  return delta;
}
