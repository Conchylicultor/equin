import { defineCard } from "../kit/types";
import "./tabs.css";

/**
 * Flexible layout, at two levels. Outside: the same apps as tabs, as floating windows, or one at a time full screen.
 * Inside the focused app: each thing opened lands in a column beside the last (inbox → a mail → the trip page it
 * belongs to, from another app), and the trail stays whatever the outer arrangement.
 * States: 0 tabs, one column · 1 two · 2 three · 3 windows · 4 full screen. The apps and columns are the same
 * elements throughout; CSS moves them (never rebuilt).
 */
export const tabsCard = defineCard({
  states: 5,
  autoplay: { seq: [0, 1, 2, 3, 4], every: [1400, 1400, 2400, 2600, 2600] },
  render: (k) => {
    const page = `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5h4.5l2.5 2.5v6.5h-7z M4.5 6h3.5 M4.5 8h3.5"/></svg>`;
    const rows = (ws: readonly number[], sel = -1) =>
      ws
        .map(
          (w, i) =>
            `<span class="tb-row${i === sel ? " sel" : ""}">${k.bar(w)}</span>`,
        )
        .join("");
    const col = (st: string, head: string, body: string, cls = "") =>
      `<span class="tb-col" data-in="${st}"><span class="tb-ch${cls}">${head}</span>${body}</span>`;
    const cols =
      `<span class="tb-cols">` +
      col("0 1 2 3 4", "<span>Inbox</span>", rows([80, 62, 74, 55, 68], 1)) +
      col("1 2 3 4", "<span>Flights</span>", rows([90, 70, 84], 2)) +
      col(
        "2 3 4",
        `${page}<span>Trip plan</span>`,
        rows([76, 88, 60]),
        " tb-other",
      ) +
      `</span>`;
    return (
      `<span class="k-html">` +
      `<span class="k-ctl">${k.segmented("mode", [
        { v: 0, label: "Tabs", on: "0 1 2" },
        { v: 3, label: "Windows", on: "3" },
        { v: 4, label: "Full screen", on: "4" },
      ])}</span>` +
      `<span class="tb-scr"><span class="tb-strip"><span class="tb-tab on">Mail</span><span class="tb-tab">Music</span></span>` +
      `<span class="tb-app tb-mail"><span class="tb-tt">Mail</span>${cols}</span>` +
      `<span class="tb-app tb-music"><span class="tb-tt">Music</span><span class="tb-ab">${[40, 76, 66, 84].map((w) => k.bar(w)).join("")}</span></span>` +
      `</span></span>`
    );
  },
  // Tabs replays the trail opening column by column; the other modes keep it
  actions: {
    mode: (ctx, el) => {
      const v = Number(el.dataset.v);
      if (v === 0) {
        ctx.run([
          [0, 0],
          [600, 1],
          [1200, 2],
        ]);
      } else {
        ctx.go(v);
      }
    },
  },
});
