import { defineCard } from "../kit/types";

/**
 * Database per agent: your data, then a copy of it for every agent, then the
 * agents change their copies while yours stays as it was. States: 0 your data
 * alone · 1 a copy forks out for each agent, one after another · 2 two agents
 * change their copy, yours is unchanged (rest). Loops.
 */
export const forksCard = defineCard({
  states: 3,
  start: 2,
  autoplay: { seq: [0, 1, 2], every: [1200, 2000, 3400] },
  render: (k) => {
    const MW = 80;
    const FW = 58;
    const MY = 14;
    const FY = 128;
    const X = [0, 1, 2, 3].map((i) => 4 + i * 76);
    const EDITED = [0, 2];
    let s = k.cylinder(151 - MW / 2, MY, MW, "your data");
    s += `<g data-in="2">${k.text(151 + MW / 2 + 8, MY + 22, "✓ unchanged", "k-ts k-mute", "start")}</g>`;
    // the copies: each link draws itself, then its copy appears
    s +=
      X.map((x, i) =>
        k.link(151, MY + 32, x + FW / 2, FY - 6, {
          in: "1 2",
          lit: true,
          delay: i * 0.3,
        }),
      ).join("") +
      `<g data-in="1 2">` +
      X.map(
        (x, i) =>
          `<g class="k-in" style="--d:${0.45 + i * 0.3}s">${k.cylinder(x, FY, FW, `agent ${i + 1}`)}</g>`,
      ).join("") +
      `</g>`;
    // the agents at work: their copy changes, yours does not
    s +=
      `<g data-in="2">` +
      EDITED.map((i, j) => {
        const x = X[i] ?? 0;
        return (
          `<g class="k-in" style="--d:${0.2 + j * 0.5}s"><path d="M${x} ${FY} v26 a${FW / 2} 6 0 0 0 ${FW} 0 v-26" class="k-lit"/>` +
          k.text(x + FW / 2, FY + 19.5, `agent ${i + 1}`, "k-tb k-ta") +
          k.text(x + FW / 2, FY + 48, "changed", "k-ts k-ta") +
          `</g>`
        );
      }).join("") +
      `</g>`;
    return k.svg(FY + 54, s);
  },
});
