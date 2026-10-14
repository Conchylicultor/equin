import { defineCard } from "../kit/types";

/** Jobs & triggers: when X happens, Y runs, with nobody pressing a button. Tap a trigger to fire it. */
export const triggersCard = defineCard({
  states: 4, // 0–2: that trigger fired · 3: nothing running (passed through to replay a trigger tapped twice)
  autoplay: { seq: [0, 1, 2], every: 2600 },
  render: (k) => {
    const R = [
      ["A mail arrives", "File it"],
      ["Every night", "Back up"],
      ["A build fails", "Open a report"],
    ] as const;
    let s = k.text(68, 12, "when", "k-cap") + k.text(236, 12, "do", "k-cap");
    R.forEach(([w, d], i) => {
      const y = 22 + i * 42;
      const m = y + 15;
      const pill = (cls: string) =>
        `<rect x="4" y="${y}" width="128" height="30" rx="15" class="${cls}"/>`;
      const job = (cls: string) =>
        `<rect x="174" y="${y}" width="124" height="30" rx="${k.R.md}" class="${cls}"/>`;
      // the trigger: the whole pill is the control
      s +=
        `<g data-act="fire" data-v="${i}" role="button" tabindex="0">${pill("k-box")}${k.icon("play", 19, m, 10, "k-ta")}${k.text(74, m + 4, w, "k-tb")}` +
        `<g data-in="${i}">${pill("k-lit")}${k.text(74, m + 4, w, "k-tb k-ta")}</g></g>`;
      s +=
        k.link(136, m, 170, m, { dir: "h", on: `${i}`, send: true }) +
        job("k-box") +
        k.text(236, m + 4, d, "k-tb");
      // fired: the link lights and sends a token to the job, which lights up, fills its progress bar and checks off
      s +=
        `<g data-in="${i}">` +
        `<g class="k-in" style="--d:.55s">${job("k-box")}${job("k-lit")}${k.text(236, m + 4, d, "k-tb k-ta")}</g>` +
        `<rect x="182" y="${y + 24}" width="108" height="3" rx="1.5" class="k-accf k-grow" style="--d:.65s;--len:1.1s"/>` +
        `<g class="k-in" style="--d:1.75s">${k.check(280, m, 1.1)}</g></g>`;
    });
    return k.svg(140, s);
  },
  // tapping the trigger already shown runs it again: through "nothing running", so its pieces enter anew
  actions: {
    fire: (ctx, el) => {
      const v = Number(el.dataset.v);
      if (ctx.state === v) ctx.go(3);
      ctx.go(v);
    },
  },
});
