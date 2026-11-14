// What the villagers say when the hero walks up to them: a stock line, not a
// dialogue — chosen from the place (the nearest building's app, the district)
// or the island's own meta chatter — and the speech bubble it is drawn in.

import type { Ctx } from "./kit";

/** Where a villager is standing when it speaks. */
export interface ChatterPlace {
  /** The app whose building is nearest, if one is close by. */
  readonly app: string | null;
  /** The district it stands in, if any. */
  readonly district: string | null;
}

const ANY: readonly string[] = [
  "Lovely day for a stroll.",
  "Hello there, traveller!",
  "Mind the gulls, they steal sandwiches.",
  "I keep walking this road. I'm not sure why.",
  "Have you tried clicking on a building? Very satisfying.",
  "They say a new house goes up every time someone builds an app.",
  "I heard the island gets bigger when nobody's looking.",
  "Some agent paints these roofs, you know. Nice brushwork.",
  "Is it just me, or does the tide never come in?",
  "I was drawn at three times my size, then shrunk. True story.",
  "Hold a building to move it. The mayor hates that.",
  "Psst. Arrow keys work too.",
  "Every so often a task gets done and the town cheers.",
  "Do you think there's an island past the fog?",
  "I'd tell you a story, but my script's only one line long.",
  "Busy, busy. The agents never sleep.",
  "Nice hat. Wait, that's your hair.",
  "Watch your step, the cobbles are freshly baked.",
  "Ah, a visitor! We don't get many of those.",
];

const NIGHT: readonly string[] = [
  "Can't sleep either?",
  "The fireflies are out. Pretty, aren't they?",
  "The windows stay lit while someone's working.",
];

const AT_APP: readonly ((app: string) => string)[] = [
  (a) => `Have you been inside ${a}? Worth a look.`,
  (a) => `${a} has been busy lately.`,
  (a) => `I hear they're always improving ${a}.`,
  (a) => `Just popped out of ${a}. Lovely place.`,
  (a) => `Knock on ${a}'s door, it opens right up.`,
  (a) => `Somebody filed a wish about ${a} this morning.`,
];

const IN_DISTRICT: readonly ((d: string) => string)[] = [
  (d) => `Welcome to ${d}!`,
  (d) => `${d} is the nicest part of the island, if you ask me.`,
  (d) => `I've lived in ${d} all my life. All three days of it.`,
];

/** A line for this place, never the one said just before (`last`). */
export function pickLine(
  place: ChatterPlace,
  night: boolean,
  rnd: () => number,
  last: string | null,
): string {
  const pool: string[] = [...ANY];
  if (night) pool.push(...NIGHT, ...NIGHT);
  if (place.app) {
    const app = place.app;
    // the place counts for about as much as the rest put together
    for (let i = 0; i < 3; i++) pool.push(...AT_APP.map((f) => f(app)));
  }
  if (place.district) {
    const d = place.district;
    pool.push(...IN_DISTRICT.map((f) => f(d)), ...IN_DISTRICT.map((f) => f(d)));
  }
  const fresh = pool.filter((l) => l !== last);
  return fresh[Math.floor(rnd() * fresh.length)] ?? pool[0]!;
}

export const BUBBLE_FONT = "700 13px Nunito, sans-serif";
const MAX_W = 190;
const PAD_X = 10;
const PAD_Y = 7;
const LINE_H = 16;

const wrapped = new Map<string, string[]>();

function wrap(g: Ctx, text: string): string[] {
  const hit = wrapped.get(text);
  if (hit) return hit;
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(next).width > MAX_W) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  wrapped.set(text, lines);
  return lines;
}

/**
 * A speech bubble whose tail points down at (x, y), in screen px; `a` fades it,
 * and it rises a few px as it fades in.
 */
export function drawBubble(
  g: Ctx,
  x: number,
  y: number,
  text: string,
  a: number,
): void {
  g.save();
  g.font = BUBBLE_FONT;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const lines = wrap(g, text);
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + PAD_X * 2;
  const h = lines.length * LINE_H + PAD_Y * 2;
  const by = y - 10 - h + (1 - a) * 6;
  const bx = x - w / 2;
  g.globalAlpha *= a;
  const tip = y + (1 - a) * 6;
  const r = 9;
  const R = bx + w;
  const B = by + h;
  g.beginPath();
  g.moveTo(bx + r, by);
  g.arcTo(R, by, R, B, r);
  g.arcTo(R, B, bx, B, r);
  g.lineTo(x + 6, B);
  g.lineTo(x, tip);
  g.lineTo(x - 6, B);
  g.arcTo(bx, B, bx, by, r);
  g.arcTo(bx, by, R, by, r);
  g.closePath();
  g.fillStyle = "rgba(38,30,20,.18)";
  g.save();
  g.translate(1.5, 2.5);
  g.fill();
  g.restore();
  g.fillStyle = "#fbf5e6";
  g.fill();
  g.strokeStyle = "rgba(38,30,20,.78)";
  g.lineWidth = 1.6;
  g.lineJoin = "round";
  g.stroke();
  g.fillStyle = "#2e261b";
  lines.forEach((l, i) =>
    g.fillText(l, x, by + PAD_Y + LINE_H * (i + 0.5) + 0.5),
  );
  g.restore();
}
