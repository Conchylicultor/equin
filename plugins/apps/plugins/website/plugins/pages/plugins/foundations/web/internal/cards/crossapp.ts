import { defineCard } from "../kit/types";

type AppId = "protos" | "agents" | "deploy" | "files" | "music" | "pages";
const H = 26;
/** The middle column is wider: it holds "Agent manager". */
const W = (id: AppId) => (N[id][0] === 151 ? 96 : 76);
const N: Record<AppId, readonly [number, number, string]> = {
  protos: [44, 16, "Prototypes"],
  agents: [151, 16, "Agent manager"],
  deploy: [258, 16, "Deploy"],
  files: [44, 76, "Files"],
  music: [151, 76, "Music"],
  pages: [258, 76, "Pages"],
};
/** [from, to, what the link does] */
const L: readonly (readonly [AppId, AppId, string])[] = [
  ["agents", "protos", "A conversation opens the prototype it mentions"],
  ["pages", "agents", "A page shows the live status of a task"],
  ["pages", "music", "A song mentioned in a page opens in Music"],
  ["files", "music", "A MIDI file plays with the Music app's player"],
  ["deploy", "agents", "A failed deploy becomes a task for an agent"],
];
/** The point on a node's border facing the other node: its side in the same row, else its top / bottom. */
const end = (a: AppId, b: AppId): [number, number, "h" | "v"] => {
  const [ax, ay] = N[a];
  const [bx, by] = N[b];
  if (ay === by) return [ax + (Math.sign(bx - ax) * W(a)) / 2, ay, "h"];
  return [ax, ay + (Math.sign(by - ay) * H) / 2, "v"];
};

/**
 * Cross-app integration: six apps, every one linked to another, as one connected graph. Every link is drawn faintly;
 * the card walks them one at a time, lighting the two apps and sending a token along the link, with what it does.
 * States: 0 conversation → prototype · 1 page → task · 2 page → song · 3 Files → Music's player · 4 deploy → task.
 */
export const crossappCard = defineCard({
  states: L.length,
  autoplay: { seq: L.map((_, i) => i), every: 2600 },
  render: (k) => {
    let s = "";
    L.forEach(([a, b], i) => {
      const [x1, y1, dir] = end(a, b);
      const [x2, y2] = end(b, a);
      s += k.link(x1, y1, x2, y2, {
        dir,
        on: `${i}`,
        fade: "faint",
        send: true,
      });
    });
    (Object.entries(N) as [AppId, readonly [number, number, string]][]).forEach(
      ([id, [x, y, t]]) => {
        const on = L.map(([a, b], i) => (a === id || b === id ? i : -1))
          .filter((i) => i >= 0)
          .join(" ");
        const w = W(id);
        s += k.box(x - w / 2, y - H / 2, w, H, { title: t });
        s += `<g data-in="${on}"><rect x="${x - w / 2}" y="${y - H / 2}" width="${w}" height="${H}" rx="${k.R.md}" class="k-lit"/></g>`;
      },
    );
    L.forEach(([, , t], i) => {
      s += `<g data-in="${i}">${k.text(151, 120, t, "k-tb k-ta")}</g>`;
    });
    return k.svg(126, s);
  },
});
