import { defineCard } from "../kit/types";
import "./mentions.css";

type Mention = "page" | "prototype" | "task";
const IC: Record<Mention, string> = {
  page: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5h4.5l2.5 2.5v6.5h-7z M4.5 6h3.5 M4.5 8h3.5"/></svg>`,
  prototype: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="2" width="9" height="8" rx="1.5"/><path d="M1.5 4.5h9"/></svg>`,
  task: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2"/><path d="M3.8 6.2l1.6 1.6l3-3.3"/></svg>`,
};
const M: Record<Mention, readonly [number, string]> = {
  task: [0, "Fix login"],
  page: [1, "Launch plan"],
  prototype: [2, "Sign-in screen"],
};

/**
 * Clickable mentions: a chat on the left; each chip the agent wrote opens its page, prototype or task on the right.
 * States: 0 task (open by default) · 1 page · 2 prototype. Every pane is drawn once and gated.
 */
export const mentionsCard = defineCard({
  states: 3,
  autoplay: { seq: [0, 1, 2], every: 2600 },
  render: (k) => {
    const chip = (m: Mention) =>
      k.hchip(IC[m] + M[m][1], {
        act: "mention",
        on: String(M[m][0]),
        attrs: `data-v="${M[m][0]}"`,
      });
    const pane = (m: Mention, body: string) =>
      `<span class="mn-pv" data-in="${M[m][0]}"><span class="mn-ph">${IC[m]}${M[m][1]}</span><span class="mn-pb">${body}</span></span>`;
    const chat =
      `<span class="mn-chat"><span class="mn-bub mn-me">Where are we on the launch?</span>` +
      `<span class="mn-bub mn-ag"><span class="mn-who">Agent</span>I updated the ${chip("page")}, drew a ${chip("prototype")} and filed ${chip("task")} for the last bug.</span></span>`;
    const panes =
      `<span class="k-panel mn-pn">` +
      pane(
        "page",
        `<span class="mn-h">Launch plan</span>${[92, 78, 86, 54].map((w) => k.bar(w)).join("")}`,
      ) +
      pane(
        "prototype",
        `<span class="mn-h" style="text-align:center">Sign in</span><span class="mn-in"></span><span class="mn-in"></span><span class="mn-btn">Continue</span>`,
      ) +
      pane(
        "task",
        `<span class="mn-st">In progress</span><span class="mn-row"><span class="mn-box"></span>Reproduce</span><span class="mn-row"><span class="mn-box"></span>Patch the session check</span>`,
      ) +
      `</span>`;
    return `<span class="k-html mn">${chat}${panes}</span>`;
  },
  actions: { mention: (ctx, el) => ctx.go(Number(el.dataset.v)) },
});
