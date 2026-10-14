import { defineCard } from "../kit/types";
import "./blocks.css";

// [markdown, block type, block text, id, the states it shows in]
const ROWS = [
  ["# Launch plan", "H1", "Launch plan", "a1", "0 1 2"],
  ["- [x] Draft the copy", "☑", "Draft the copy", "b7", "0 1 2"],
  ["- [ ] Ship the beta", "☐", "Ship the beta", "c4", "1 2"],
  ["> Dates are fixed", "❝", "Dates are fixed", "d2", "0 1 2"],
] as const;
const NEW = 2; // the row the agent writes

/**
 * Markdown ↔ blocks: the same page twice. Left, the markdown the agent reads
 * and writes; right, the structured blocks the page is stored as (each with its
 * type and id). Read: the blocks are turned into markdown. Write: the agent
 * adds one line, and it lands as one new block; the others are untouched.
 * States: 0 read · 1 the agent writes a line · 2 it lands as a block.
 */
export const blocksCard = defineCard({
  states: 3,
  autoplay: { seq: [0, 1, 2], every: [2800, 1500, 3000] },
  render: (k) => {
    const md = ROWS.map(
      ([m, , , , st], i) =>
        `<span class="bk-r${i === NEW ? " bk-new" : ""}" data-in="${st}">${m}</span>`,
    ).join("");
    const blocks = ROWS.map(
      ([, ty, tx, id, st], i) =>
        `<span class="bk-r${i === NEW ? " bk-new" : ""}" data-in="${i === NEW ? "2" : st}"><span class="bk-ty">${ty}</span><span class="bk-tx">${tx}</span><span class="bk-id">${id}</span></span>` +
        (i === NEW ? `<span class="bk-ph" data-in="1"></span>` : ""),
    ).join("");
    const ctl =
      `<span class="k-ctl">${k.segmented("go", [
        { v: 0, label: "Agent reads", on: "0" },
        { v: 1, label: "Agent writes", on: "1 2" },
      ])}` +
      `<span class="k-sp"></span><span class="k-hint" data-in="2">+1 block, rest untouched</span></span>`;
    return (
      `<span class="k-html">${ctl}<span class="bk">` +
      `<span class="bk-col"><span class="bk-lab">Stored blocks</span><span class="k-panel bk-pn">${blocks}</span></span>` +
      `<span class="bk-mid"><span data-in="0"><span class="bk-arr">→</span><br><span class="bk-verb">read</span></span>` +
      `<span data-in="1 2"><span class="bk-arr">←</span><br><span class="bk-verb">write</span></span></span>` +
      `<span class="bk-col"><span class="bk-lab"><span data-in="0">Agent reads</span><span data-in="1 2">Agent writes</span></span><span class="k-panel bk-pn bk-md">${md}</span></span>` +
      `</span></span>`
    );
  },
  actions: {
    go: (ctx, el) => {
      if (Number(el.dataset.v) === 0) ctx.go(0);
      else
        ctx.run([
          [0, 1],
          [1200, 2],
        ]);
    },
  },
});
