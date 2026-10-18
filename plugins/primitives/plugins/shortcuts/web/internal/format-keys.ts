import { isMac } from "./parse-keys";

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  ctrl: "⌃",
  control: "⌃",
  meta: "⌘",
  cmd: "⌘",
};

const PC_LABELS: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  ctrl: "Ctrl",
  control: "Ctrl",
  meta: "Ctrl",
  cmd: "Ctrl",
};

const MODIFIERS = new Set(Object.keys(MAC_SYMBOLS));

/** Named keys drawn as their glyph on every platform (`arrowup` → `↑`). */
const KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  enter: "↵",
  backquote: "`",
  pageup: "PgUp",
  pagedown: "PgDn",
};

export function formatShortcutLabel(keys: string): string {
  const tokens = keys.toLowerCase().split("+").filter(Boolean);
  const mods: string[] = [];
  let key = "";

  for (const token of tokens) {
    if (MODIFIERS.has(token)) {
      const label = isMac ? MAC_SYMBOLS[token]! : PC_LABELS[token]!;
      if (!mods.includes(label)) mods.push(label);
    } else {
      key =
        KEY_GLYPHS[token] ??
        (token.length === 1 ? token.toUpperCase() : capitalize(token));
    }
  }

  if (isMac) {
    return mods.join("") + key;
  }
  return [...mods, key].filter(Boolean).join("+");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
