import { defineCard } from "../kit/types";

/**
 * Safe data updates: on the left, the change (what a contact holds: "name"
 * renamed to "full name", "phone" added); on the right, the records you already
 * have, which take the new shape as the change lands.
 * States: 0 before · 1 the change is made · 2 your records are upgraded to match (rest).
 */
export const migrationsCard = defineCard({
  states: 3,
  start: 2,
  autoplay: { seq: [0, 1, 2], every: [1600, 1300, 4000] },
  render: (k) => {
    const LX = 4;
    const LY = 22;
    const LW = 92;
    const RX = 128;
    const RW = 170;
    const ROWS = [
      ["Ada", "ada@mail"],
      ["Linus", "linus@mail"],
      ["Grace", "grace@mail"],
    ] as const;
    let s =
      k.text(LX + LW / 2, 12, "The change", "k-cap") +
      k.text(RX + RW / 2, 12, "Your records", "k-cap");
    // the change: a contact's fields
    s +=
      `<rect x="${LX}" y="${LY}" width="${LW}" height="86" rx="${k.R.md}" class="k-plug"/>` +
      k.text(LX + 10, LY + 17, "Contact", "k-tl k-ta", "start");
    const field = (y: number, t: string, cls = "k-box", txt = "k-t") =>
      `<rect x="${LX + 8}" y="${y}" width="${LW - 16}" height="16" rx="3" class="${cls}"/>` +
      k.text(LX + 15, y + 11, t, txt, "start");
    s +=
      `<g data-on="1 2" class="k-sw"><rect x="${LX + 8}" y="${LY + 26}" width="${LW - 16}" height="16" rx="3" class="k-box"/></g>` +
      `<g data-in="0">${k.text(LX + 15, LY + 37, "name", "k-t", "start")}</g><g data-in="1 2">${k.text(LX + 15, LY + 37, "full name", "k-tb", "start")}</g>`;
    s += field(LY + 46, "email");
    s += `<g data-in="1 2">${field(LY + 66, "+ phone", "k-lit", "k-tb")}</g>`;
    s += k.link(LX + LW + 4, LY + 43, RX - 6, LY + 43, { dir: "h" });
    // your records: header, then one row per record; in state 2 each row is lit in turn as it is upgraded
    const C = [RX + 8, RX + 62, RX + 134] as const;
    s += `<rect x="${RX}" y="${LY}" width="${RW}" height="86" rx="${k.R.md}" class="k-box"/>`;
    s += `<g data-in="0 1">${k.text(C[0], LY + 15, "name", "k-ts k-mute", "start")}</g><g data-in="2">${k.text(C[0], LY + 15, "full name", "k-tb k-ta", "start")}</g>`;
    s +=
      k.text(C[1], LY + 15, "email", "k-ts k-mute", "start") +
      `<g data-in="2">${k.text(C[2], LY + 15, "phone", "k-tb k-ta", "start")}</g>`;
    ROWS.forEach(([n, e], i) => {
      const y = LY + 22 + i * 21;
      s += `<g data-in="2"><rect x="${RX + 4}" y="${y}" width="${RW - 8}" height="18" rx="3" class="k-lit k-in" style="--d:${0.15 + i * 0.25}s"/></g>`;
      s +=
        k.text(C[0], y + 12.5, n, "k-t", "start") +
        k.text(C[1], y + 12.5, e, "k-ts", "start");
      s += `<g data-in="2">${k.text(C[2], y + 12.5, "—", "k-ts k-mute", "start")}</g>`;
    });
    return k.svg(112, s);
  },
});
