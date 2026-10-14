import { DRAW } from "../kit/draw";
import { defineCard, type CardCtx, type KitElement } from "../kit/types";

const COPIES = ["Your app", "Agent copy", "Agent copy"] as const;
const AW = 94;
const AH = 52;
const AY = 6;
const X = [0, 104, 208] as const;
const CX = 91;
const CY = 110;
const CW = 120;
const CH = 44;
const top = CX + CW / 2;

export interface CentralData {
  copies: KitElement[];
  central: KitElement;
  timers: (() => void)[];
}

// sign in (or out, when already in) from your app: up to Central, then down to every agent's copy
const signin = (ctx: CardCtx<CentralData>, el: KitElement) => {
  const i = Number(el.dataset.k);
  const signIn = ctx.state === 0;
  const { copies, central } = ctx.data;
  // a new sign-in replaces what the last one had left to do
  ctx.data.timers.forEach((d) => {
    d();
  });
  ctx.data.timers = [];
  const later = (ms: number, fn: () => void) =>
    ctx.data.timers.push(ctx.after(ms, fn));
  ctx.go(signIn ? 1 : 0);
  ctx.part(el, signIn ? "here" : "out");
  ctx.fire(`up${i}`);
  const hop = DRAW * 1000; // one link's draw: the sign-in's trip along it
  later(hop, () => {
    ctx.part(central, "hit");
    copies.forEach((_, j) => {
      if (j !== i) ctx.fire(`down${j}`);
    });
  });
  later(hop + 350, () => ctx.part(central, "rest"));
  later(2 * hop, () =>
    copies.forEach((c, j) => {
      if (j !== i) ctx.part(c, signIn ? "in" : "out");
    }),
  );
};

/**
 * Central: you sign in once, in your own app; the sign-in travels to Central, which keeps it and shares it with every
 * agent's copy (you rarely open those, and never sign in there). Signing out of your app signs them all out. Each copy
 * is a part (out · here · in); the card's own state is the sign-in itself (0 signed out · 1 signed in). The loop signs
 * in and out of your app.
 */
export const centralCard = defineCard<CentralData>({
  states: 2,
  autoplay: {
    every: 2600,
    lead: 900,
    step: (ctx) => signin(ctx, ctx.q<KitElement>("[data-copy]")),
  },
  render: (k) => {
    let s = "";
    COPIES.forEach((t, i) => {
      const x = X[i] ?? 0;
      const cx = x + AW / 2;
      const by = AY + AH;
      // your app sends its sign-in up to Central; Central sends it down to each agent's copy
      s +=
        i === 0
          ? k.link(cx, by, top, CY, { dir: "v", shot: `up${i}`, send: true })
          : k.link(top, CY, cx, by, { dir: "v", shot: `down${i}`, send: true });
      const frame = (at: string, cls: string) =>
        `<rect data-at="${at}" x="${x}" y="${AY}" width="${AW}" height="${AH}" rx="${k.R.md}" class="${cls}"/>`;
      // only your app has a sign-in button; an agent's copy just shows whether it has the sign-in
      const mine = i === 0;
      s +=
        `<g data-copy="${i}" data-k="${i}"${mine ? ` data-act="signin" role="button" tabindex="0" aria-label="Sign in or out"` : ""}>` +
        frame("out", "k-box") +
        frame("here in", "k-box") +
        frame("here in", "k-lit") +
        k.text(cx, AY + 18, t, "k-tb") +
        `<g data-at="out">${mine ? k.button(cx, AY + 26, 58, "", "Sign in") : k.text(cx, AY + 38.5, "not signed in", "k-ts k-mute")}</g>` +
        `<g data-at="here">${k.text(cx, AY + 38.5, "✓ signed in", "k-ts k-ta")}</g>` +
        `<g data-at="in">${k.text(cx, AY + 38.5, "✓ signed in", "k-ts k-ta")}</g></g>`;
    });
    // Central lights up as the sign-in reaches it
    s +=
      `<g data-central><rect x="${CX}" y="${CY}" width="${CW}" height="${CH}" rx="${k.R.md}" class="k-box"/>` +
      `<rect x="${CX}" y="${CY}" width="${CW}" height="${CH}" rx="${k.R.md}" class="k-lit"/>` +
      `<rect data-at="hit" x="${CX}" y="${CY}" width="${CW}" height="${CH}" rx="${k.R.md}" class="k-plug"/>` +
      k.text(top, CY + 19, "Central", "k-tb") +
      k.text(top, CY + 32, "keeps your sign-in", "k-ts k-mute") +
      `</g>`;
    s +=
      k.text(CX + CW + 8, CY + 19, "shares it with", "k-ts k-mute", "start") +
      k.text(CX + CW + 8, CY + 31, "every agent copy", "k-ts k-mute", "start");
    return k.svg(160, s);
  },
  mount: (ctx) => {
    const copies = ctx.qa<KitElement>("[data-copy]");
    const central = ctx.q<KitElement>("[data-central]");
    Object.assign(ctx.data, { copies, central, timers: [] });
    copies.forEach((c) => ctx.part(c, "out", true));
    ctx.part(central, "rest", true);
  },
  actions: { signin: (ctx, el) => signin(ctx, el) },
});
