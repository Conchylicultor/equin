/** Everything a key can ask of the player. */
export type PlayerAction =
  | { kind: "toggle" }
  | { kind: "skip"; seconds: number }
  | { kind: "volume"; delta: number }
  | { kind: "mute" }
  | { kind: "fullscreen" }
  | { kind: "pip" }
  | { kind: "loop" }
  | { kind: "speed"; delta: number }
  | { kind: "jump"; digit: number }
  | { kind: "close-settings" };

export interface PlayerKey {
  id: string;
  /** A shortcut-registry combo (`primitives/shortcuts` grammar). */
  keys: string;
  label: string;
  action: PlayerAction;
  /** Only a video player has it (no picture to fill a screen or float). */
  videoOnly?: true;
}

/**
 * The player's keyboard, as data: Space / K play, ← → 5 s, ↑ ↓ volume,
 * M mute, F full screen, P picture in picture, R loop, < > speed, 0–9 jump,
 * Esc closes the settings. Space itself is bound through
 * `usePlayPauseShortcut` (every player shares that binding), so it is not
 * listed here; the rest register as surface shortcuts on the page, and the
 * same table drives the player's own key handler in its picture-in-picture
 * window, where the page's listener does not hear keys.
 */
export const PLAYER_KEYS: readonly PlayerKey[] = [
  { id: "k", keys: "k", label: "Play / pause", action: { kind: "toggle" } },
  {
    id: "back",
    keys: "arrowleft",
    label: "Back 5 seconds",
    action: { kind: "skip", seconds: -5 },
  },
  {
    id: "forward",
    keys: "arrowright",
    label: "Forward 5 seconds",
    action: { kind: "skip", seconds: 5 },
  },
  {
    id: "louder",
    keys: "arrowup",
    label: "Volume up",
    action: { kind: "volume", delta: 1 },
  },
  {
    id: "quieter",
    keys: "arrowdown",
    label: "Volume down",
    action: { kind: "volume", delta: -1 },
  },
  { id: "mute", keys: "m", label: "Mute", action: { kind: "mute" } },
  {
    id: "fullscreen",
    keys: "f",
    label: "Full screen",
    action: { kind: "fullscreen" },
    videoOnly: true,
  },
  {
    id: "pip",
    keys: "p",
    label: "Picture in picture",
    action: { kind: "pip" },
    videoOnly: true,
  },
  { id: "loop", keys: "r", label: "Loop", action: { kind: "loop" } },
  {
    id: "faster",
    keys: "shift+>",
    label: "Faster",
    action: { kind: "speed", delta: 1 },
  },
  {
    id: "slower",
    keys: "shift+<",
    label: "Slower",
    action: { kind: "speed", delta: -1 },
  },
  ...Array.from({ length: 10 }, (_, digit) => ({
    id: `jump-${digit}`,
    keys: `${digit}`,
    label: `Jump to ${digit * 10}%`,
    action: { kind: "jump", digit } as const,
  })),
  {
    id: "close-settings",
    keys: "escape",
    label: "Close settings",
    action: { kind: "close-settings" },
  },
];

/**
 * Whether a keystroke is this combo — for the player's own handler in its
 * picture-in-picture window. The same grammar the registry reads: `shift+`
 * prefixes, `space` for " "; no other modifier may be held.
 */
export function matchesKeys(
  keys: string,
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const parts = keys.split("+");
  const shift = parts.length === 2 && parts[0] === "shift";
  const key =
    parts[parts.length - 1] === "space" ? " " : parts[parts.length - 1];
  return e.key.toLowerCase() === key && e.shiftKey === shift;
}
