import { defineCard, type CardCtx } from "../kit/types";
import "./optimistic.css";

export interface OptimisticData {
  /** row → the disposer of its pending server answer */
  timers: Map<Element, () => void>;
}

const ROWS = [
  ["Buy milk", true],
  ["Call bank", false],
  ["Book flights", false],
] as const;
const LISTS = [
  ["without", "Waits for the server"],
  ["with", "Optimistic"],
] as const;

const tick = (ctx: CardCtx<OptimisticData>, row: HTMLElement) => {
  const list = row.closest<HTMLElement>(".op-list");
  const wait = list?.dataset.mode === "without";
  const T = ctx.data.timers;
  if (wait && row.classList.contains("pend")) return; // the box does not move until the server answers
  T.get(row)?.();
  if (wait) {
    row.classList.add("pend");
    row.dataset.st = "wait";
    T.set(
      row,
      ctx.after(350, () => {
        T.delete(row);
        row.classList.remove("pend");
        row.classList.toggle("on");
        row.dataset.st = "";
      }),
    );
  } else {
    row.classList.toggle("on");
    row.dataset.st = "saving";
    T.set(
      row,
      ctx.after(350, () => {
        T.delete(row);
        row.dataset.st = "saved";
      }),
    );
  }
};

/**
 * Optimistic updates: the same three-item list twice. Waiting: a ticked box waits for the server before it moves.
 * Optimistic: it ticks at once, says saving…, then ✓ saved. Each row keeps its own status in place (classes and a
 * data-st attribute; every status label is drawn once and gated by CSS), so nothing is rebuilt on a click.
 * No autoplay: the reader ticks boxes in both lists and feels the difference.
 */
export const optimisticCard = defineCard<OptimisticData>({
  render: () =>
    `<span class="k-html">` +
    LISTS.map(([mode, label], li) => {
      const rows = ROWS.map(
        ([n, on]) =>
          `<span class="op-r${on ? " on" : ""}" data-act="tick" role="button" tabindex="0">` +
          `<span class="op-ck"></span><b>${n}</b><span class="op-os">` +
          `<span class="op-wait"><span class="op-spin"></span>waiting…</span><span class="op-saving"><span class="op-spin"></span>saving…</span><span class="op-saved">✓ saved</span>` +
          `</span></span>`,
      ).join("");
      return (
        `<span class="op-head"><span class="op-lab${li ? " acc" : ""}">${label}</span></span>` +
        `<span class="k-panel op-list" data-mode="${mode}">${rows}</span>`
      );
    }).join("") +
    `</span>`,
  mount: (ctx) => {
    ctx.data.timers = new Map();
  },
  actions: {
    tick: (ctx, row) => {
      if (row instanceof HTMLElement) tick(ctx, row);
    },
  },
});
