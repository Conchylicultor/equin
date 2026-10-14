import { defineCard } from "../kit/types";
import "./themes.css";

const THEMES = ["Studio", "Paper", "Terminal"] as const;
const ROWS = [
  ["Ana", "Lunch on Friday?"],
  ["Build bot", "Deploy finished"],
  ["Sam", "Notes from the call"],
] as const;

/**
 * Themes: one small app wearing three whole personalities — colours, type, corners, spacing AND the shape of its
 * tabs and sidebar. States: 0 studio · 1 paper · 2 terminal. The mini app keeps its own fixed colours per theme (that is
 * the point of the card); only the controls use the card palette.
 */
export const themesCard = defineCard({
  states: 3,
  autoplay: { seq: [0, 1, 2], every: 2600 },
  render: (k) => {
    const ctl = k.segmented(
      "theme",
      THEMES.map((name, s) => ({ v: s, label: name, on: String(s) })),
    );
    const rows = ROWS.map(
      ([a, b]) =>
        `<span class="th-row"><i></i><b>${a}</b><span>${b}</span></span>`,
    ).join("");
    const app =
      `<span class="th-app"><span class="th-side"><b class="on">Inbox</b><b>Sent</b><b>Archive</b></span>` +
      `<span class="th-main"><span class="th-tabs"><span class="th-tab on">Mail</span><span class="th-tab">Tasks</span><span class="th-tab">Pages</span><span class="th-btn">Write</span></span>` +
      `<span class="th-body">${rows}</span></span></span>`;
    return `<span class="k-html"><span class="k-ctl">${ctl}</span>${app}</span>`;
  },
  actions: { theme: (ctx, el) => ctx.go(Number(el.dataset.v)) },
});
