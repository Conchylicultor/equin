import { defineCard } from "../kit/types";

/**
 * System status: one dot in any app; click it to open (or close) what it tells you.
 * States: 0 popover open · 1 closed (the dot pulses "click me").
 */
export const statusCard = defineCard({
  states: 2,
  autoplay: { seq: [0, 1], every: [3000, 1400] },
  render: (k) => {
    let s =
      k.box(4, 4, 294, 24) +
      k.text(14, 19.5, "any app", "k-ts k-mute", "start");
    s +=
      `<g data-act="status" role="button" tabindex="0" aria-label="Status"><circle cx="284" cy="16" r="11" class="k-hit"/>` +
      `<circle cx="284" cy="16" r="4.5" class="k-ring" data-in="1"/><circle cx="284" cy="16" r="4.5" class="k-accf"/></g>`;
    // the popover, its arrow pointing at the dot
    const P = { x: 128, y: 38, w: 170, h: 98 };
    let pop =
      `<path d="M278 ${P.y + 1} l6 -7 l6 7" class="k-box"/>` +
      k.box(P.x, P.y, P.w, P.h) +
      `<path d="M279.5 ${P.y + 0.5} h9" class="k-inv"/>`;
    const ITEMS: readonly (readonly [string, string?])[] = [
      ["All healthy"],
      ["Build running"],
      ["Deployed", "3 min ago"],
    ];
    ITEMS.forEach(([a, b], i) => {
      const y = P.y + 22 + i * 28;
      const ix = P.x + 16;
      if (i)
        pop += `<path d="M${P.x + 9} ${y - 14} H${P.x + P.w - 9}" class="k-ink k-faint"/>`;
      if (i === 0)
        pop += `<circle cx="${ix}" cy="${y - 3.5}" r="6" class="k-accf"/><path d="M${ix - 3} ${y - 3.5} l2 2 l4 -4.2" class="k-inv"/>`;
      if (i === 1) pop += k.spinner(ix, y - 3.5, 5.5);
      if (i === 2)
        pop += `<path d="M${ix} ${y + 2} v-11 m-4.5 4.5 l4.5 -4.5 l4.5 4.5" class="k-ink"/>`;
      pop += k.text(P.x + 30, y, a, "k-tb", "start");
      if (b) pop += k.text(P.x + P.w - 10, y, b, "k-ts", "end");
    });
    s += `<g data-in="0">${pop}</g>`;
    return k.svg(140, s);
  },
  actions: { status: (ctx) => ctx.go(ctx.state ? 0 : 1) },
});
