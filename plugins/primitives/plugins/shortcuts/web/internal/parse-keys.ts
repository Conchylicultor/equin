import type { ParsedCombo } from "./types";

export const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  space: " ",
};

export function parseCombo(keys: string): ParsedCombo | null {
  const combo: ParsedCombo = {
    mod: false,
    ctrl: false,
    shift: false,
    alt: false,
    key: "",
  };

  const tokens = keys.toLowerCase().split("+").filter(Boolean);
  if (tokens.length === 0) return null;

  for (const token of tokens) {
    if (token === "mod" || token === "meta" || token === "cmd") {
      combo.mod = true;
    } else if (token === "ctrl" || token === "control") {
      combo.ctrl = true;
    } else if (token === "shift") {
      combo.shift = true;
    } else if (token === "alt" || token === "option") {
      combo.alt = true;
    } else if (combo.key === "") {
      combo.key = KEY_ALIASES[token] ?? token;
    } else {
      return null;
    }
  }

  if (combo.key === "") return null;
  return combo;
}

/**
 * The layout-independent letter / digit a physical key stands for (`KeyN` →
 * `n`, `Digit1` → `1`), or null for any other key.
 */
function codeChar(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  return m ? (m[1] ?? m[2]!).toLowerCase() : null;
}

/**
 * Whether the event's key is the combo's key. With Alt held, a letter or digit
 * is matched on the PHYSICAL key (`e.code`): on macOS ⌥ composes a different
 * character (⌥N is the dead key "˜", ⌥P is "π"), so `e.key` would never equal
 * the combo's letter and every alt+<letter> shortcut would be dead there.
 */
function keyMatches(parsed: ParsedCombo, e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() === parsed.key) return true;
  return e.altKey && codeChar(e.code) === parsed.key;
}

export function matchesEvent(parsed: ParsedCombo, e: KeyboardEvent): boolean {
  if (!keyMatches(parsed, e)) return false;

  if (isMac) {
    if (parsed.mod !== e.metaKey) return false;
    if (parsed.ctrl !== e.ctrlKey) return false;
  } else {
    // mod and ctrl both map to ctrlKey on non-Mac
    if ((parsed.mod || parsed.ctrl) !== e.ctrlKey) return false;
    if (e.metaKey) return false;
  }

  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;

  return true;
}

const comboCache = new Map<string, ParsedCombo | null>();

export function getCachedCombo(keys: string): ParsedCombo | null {
  let cached = comboCache.get(keys);
  if (cached === undefined) {
    cached = parseCombo(keys);
    comboCache.set(keys, cached);
  }
  return cached;
}
