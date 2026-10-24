import {
  isEmoji,
  type Emoji,
} from "@plugins/ui/plugins/icons/plugins/emoji/core";

export type IconAnswer =
  { ok: true; emoji: Emoji } | { ok: false; reason: string };

const VS16 = "️";

// One answer line's value as an emoji, or undefined. A model often drops the
// variation selector a fully-qualified emoji needs (🗺 for 🗺️), which is not an
// RGI emoji on its own — so a bare value that fails is retried with VS16.
function emojiOf(value: string | undefined): Emoji | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (isEmoji(v)) return v;
  const qualified = v + VS16;
  return isEmoji(qualified) ? qualified : undefined;
}

function lineValue(out: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, "im");
  return re.exec(out)?.[1];
}

/**
 * The model's `EMOJI:` / `ALT:` answer → the icon to write. EMOJI unless one of
 * `avoid` (the siblings' icons) already has it, else ALT, else EMOJI anyway (a
 * collision beats no icon). A line that is not exactly one emoji is ignored;
 * with neither usable the answer is unusable, and nothing is written.
 */
export function parseIconAnswer(
  out: string,
  avoid: ReadonlySet<string>,
): IconAnswer {
  const primary = emojiOf(lineValue(out, "EMOJI"));
  const alt = emojiOf(lineValue(out, "ALT"));
  const pick =
    [primary, alt].find((e) => e !== undefined && !avoid.has(e)) ??
    primary ??
    alt;
  if (pick === undefined) {
    return {
      ok: false,
      reason: `no usable emoji in answer: ${JSON.stringify(out.slice(0, 200))}`,
    };
  }
  return { ok: true, emoji: pick };
}
