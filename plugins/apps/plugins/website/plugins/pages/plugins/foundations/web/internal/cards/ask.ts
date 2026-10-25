import { defineCard } from "../kit/types";
import "./ask.css";

const IC = {
  moon: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M9.8 7.4A4.2 4.2 0 0 1 4.6 2.2a4.2 4.2 0 1 0 5.2 5.2z"/></svg>`,
  share: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v6 M3.5 4L6 1.5L8.5 4 M2 7v3h8V7"/></svg>`,
  eye: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6s1.8-3.5 5-3.5S11 6 11 6s-1.8 3.5-5 3.5S1 6 1 6z"/><circle cx="6" cy="6" r="1.5"/></svg>`,
  task: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2"/><path d="M3.8 6.2l1.6 1.6l3-3.3"/></svg>`,
};

/**
 * Ask equin: the ? button opens a chat card floating over the app. The agent answers from the app's code, points at
 * the control it means on the page underneath, and files a task when the answer is a change to the app.
 * States: 0 closed · 1 asked · 2 answered · 3 the control it means is ringed on the page · 4 a task filed.
 * The card is anchored to its bottom-right corner, so it grows upwards as the thread does.
 */
export const askCard = defineCard({
  states: 5,
  autoplay: { seq: [0, 1, 2, 3, 4], every: [1400, 1700, 1900, 2200, 2800] },
  render: (k) => {
    const bar =
      `<span class="as-bar"><span>Roadmap</span>` +
      `<span class="as-ic">${IC.share}</span>` +
      `<span class="as-ic">${IC.moon}<span class="as-ring" data-in="3"></span></span>` +
      `<span class="as-ic" data-act="ask" role="button" tabindex="0" aria-label="Ask equin" data-on="1 2 3 4">?</span></span>`;
    const body = `<span class="as-body"><span class="as-h">Roadmap</span>${[94, 80, 88, 62, 84, 70, 46].map((w) => k.bar(w)).join("")}</span>`;
    const card =
      `<span class="as-card" data-in="1 2 3 4">` +
      `<span class="as-head"><span class="as-mark">?</span>Ask equin</span><span class="as-th">` +
      `<span class="as-bub as-me">How do I switch to dark mode?</span>` +
      `<span class="as-bub as-ag" data-in="2 3 4">The moon button in the top bar switches this app to dark.<br>` +
      k.hchip(IC.eye + "Show me", { act: "show", on: "3" }) +
      `</span>` +
      `<span class="as-bub as-me" data-in="4">Can it turn dark only at night?</span>` +
      `<span class="as-bub as-ag" data-in="4">Not yet, so I filed a task.` +
      `<span class="as-task">${IC.task}Dark mode at night<span class="as-st">Running</span></span></span>` +
      `</span></span>`;
    return `<span class="k-html"><span class="k-panel as">${bar}${body}${card}</span></span>`;
  },
  actions: {
    ask: (ctx) => ctx.go(ctx.state === 0 ? 1 : 0),
    show: (ctx) => ctx.go(3),
  },
});
