import { DRAW } from "../kit/draw";
import { defineCard, type CardCtx } from "../kit/types";

const ROWS = [
  ["mail.localhost", "Mail", "running"],
  ["fix-login.localhost", "Agent copy", "running"],
  ["new-menu.localhost", "Agent copy", "asleep"],
] as const;
const AW = 104;
const CH = 22;
const GX = 118;
const GW = 58;
const GY = 58;
const GH = 44;
const SX = 206;
const SW = 96;
const SH = 38;
const Y0 = 12;
const STEP = 52;
const gm = GY + GH / 2;
const TOUR = [2, 0, 1] as const;
const SLEEP = 4600;

export interface GatewayData {
  rows: HTMLElement[];
  timers: (() => void)[][];
  tour: number;
}

const visit = (ctx: CardCtx<GatewayData>, i: number) => {
  const row = ctx.data.rows[i];
  const timers = ctx.data.timers[i];
  if (!row || !timers) throw new Error(`gateway: no row ${i}`);
  // a new visit replaces what the last one on this row had left to do
  timers.forEach((d) => {
    d();
  });
  timers.length = 0;
  const later = (ms: number, st: string) =>
    timers.push(ctx.after(ms, () => ctx.part(row, st)));
  ctx.fire(`visit${i}`);
  // the request lands after its two hops (each one link's draw)
  const lands = 2 * DRAW * 1000;
  if (row.dataset.p === "running" || row.dataset.p === "hit") {
    later(lands, "hit");
    later(lands + 450, "running");
  } else {
    later(lands, "waking");
    later(lands + 1150, "running");
  }
  // agent copies go back to sleep when nobody visits them for a while; Mail stays up
  if (i > 0) later(SLEEP, "asleep");
};

/**
 * The gateway: every version of the app has its own address. Click an address: a request travels through the
 * Gateway to that version's own server; a sleeping one wakes up on the visit, and an agent's copy falls asleep
 * again when nobody visits it for a while. Each row (address → server) is a part with its own state. The loop visits
 * the rows in turn (the sleeping copy first), slowly enough that each agent copy dozes off between its visits.
 */
export const gatewayCard = defineCard<GatewayData>({
  autoplay: {
    every: 2000,
    lead: 600,
    step: (ctx) => visit(ctx, TOUR[ctx.data.tour++ % TOUR.length] ?? 0),
  },
  render: (k) => {
    let s = k.box(GX, GY, GW, GH, { title: "Gateway" });
    ROWS.forEach(([addr, name], i) => {
      const cy = Y0 + i * STEP + CH / 2;
      const sy = cy - SH / 2;
      const scx = SX + SW / 2;
      const srv = (at: string, cls: string) =>
        `<rect data-at="${at}" x="${SX}" y="${sy}" width="${SW}" height="${SH}" rx="${k.R.md}" class="${cls}"/>`;
      s +=
        `<g data-row="${i}">` +
        // the request's two hops: each lights and carries it in turn
        k.link(AW, cy, GX, gm, { dir: "h", shot: `visit${i}`, send: true }) +
        k.link(GX + GW, gm, SX, cy, {
          dir: "h",
          shot: `visit${i}`,
          send: true,
          delay: k.DRAW,
        }) +
        // the address: a pill you click, its outline breathing while its server sleeps
        `<g class="k-chip" data-act="visit" data-k="${i}" role="button" tabindex="0" aria-label="Visit ${addr}">` +
        `<rect x="0" y="${cy - CH / 2}" width="${AW}" height="${CH}" rx="${CH / 2}" class="k-box"/>${k.text(AW / 2, cy + 3.5, addr, "k-ts")}</g>` +
        `<rect data-at="asleep" x="0" y="${cy - CH / 2}" width="${AW}" height="${CH}" rx="${CH / 2}" class="k-acc k-pulse" pointer-events="none"/>` +
        // its server: dashed while asleep, lit while waking, lit for a moment when a visit lands on it running
        srv("asleep waking", "k-box k-dash") +
        srv("running hit", "k-box") +
        srv("waking", "k-acc k-dash") +
        srv("hit", "k-acc") +
        `<g data-at="asleep">${k.text(scx, cy - 2, name, "k-tb k-mute")}</g><g data-at="waking running hit">${k.text(scx, cy - 2, name, "k-tb")}</g>` +
        `<g data-at="asleep">${k.text(scx, cy + 11, "asleep", "k-ts k-mute")}</g>` +
        `<g data-at="waking">${k.text(scx, cy + 11, "waking up…", "k-ts k-ta")}</g>` +
        `<g data-at="running hit">${k.text(scx, cy + 11, "running", "k-ts k-mute")}</g>` +
        `</g>`;
    });
    return k.svg(156, s);
  },
  mount: (ctx) => {
    const rows = ctx.qa("[data-row]");
    Object.assign(ctx.data, { rows, timers: ROWS.map(() => []), tour: 0 });
    rows.forEach((row, i) => ctx.part(row, ROWS[i]?.[2] ?? "running", true));
  },
  actions: {
    visit: (ctx, el) => visit(ctx, Number(el.dataset.k)),
  },
});
