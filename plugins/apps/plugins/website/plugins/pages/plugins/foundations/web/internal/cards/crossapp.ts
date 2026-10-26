import { defineCard } from "../kit/types";
import "./crossapp.css";

const IC = {
  bot: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="4" width="8" height="6" rx="1.2"/><path d="M6 4V2H4.5 M4.5 6.5v1 M7.5 6.5v1"/></svg>`,
  page: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5h4l2.5 2.5v6.5H3z M7 1.5V4h2.5 M4.5 6.5h3 M4.5 8.5h3"/></svg>`,
  proto: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="2" width="9" height="8" rx="1.2"/><path d="M1.5 4.5h9 M4.5 4.5V10"/></svg>`,
  music: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 9V2.5l5-1V8"/><circle cx="3.3" cy="9" r="1.3"/><circle cx="8.3" cy="8" r="1.3"/></svg>`,
  folder: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 3h3l1 1.2h5V9.5h-9z"/></svg>`,
  file: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5h4l2.5 2.5v6.5H3z M7 1.5V4h2.5"/></svg>`,
  hammer: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M7 5L2.5 9.5 M5 3l2-1.5 3 3L8.5 6.5z"/></svg>`,
  task: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2"/><path d="M3.8 6.2l1.6 1.6l3-3.3"/></svg>`,
  ok: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.2 4.7-5"/></svg>`,
  x: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6 M9 3l-6 6"/></svg>`,
  pin: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.5S2.5 7.2 2.5 4.8a3.5 3.5 0 0 1 7 0C9.5 7.2 6 10.5 6 10.5z"/><circle cx="6" cy="4.8" r="1.2"/></svg>`,
  play: `<svg class="k-hic" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5l5.5 3.5L4 9.5z"/></svg>`,
};

/** An app as the card draws it: its icon and its name. */
type App = readonly [icon: string, name: string];
interface Scene {
  /** The app the view appears in. */
  host: App;
  /** The app the view comes from, and the view. */
  guest: readonly [app: App, view: string];
  /** The host's content; `slot` is where the view appears. */
  body: (slot: string) => string;
}

const bar = (pct: number) =>
  `<span class="k-bar" style="width:${pct}%"></span>`;
const task = (title: string) =>
  `<span class="xa-task">${IC.task}<span class="xa-tt">${title}</span><span class="xa-st"><span class="xa-spin"></span>Running</span></span>` +
  `<span class="xa-prog"><span></span></span>`;
/** A piano roll: [start, length, pitch row] on a 0–100 time axis. */
const NOTES: readonly (readonly [number, number, number])[] = [
  [2, 14, 1],
  [18, 10, 3],
  [30, 14, 2],
  [46, 8, 4],
  [56, 14, 1],
  [72, 10, 3],
  [84, 12, 0],
];
const FILES: readonly (readonly [string, string, boolean])[] = [
  [IC.folder, "songs", false],
  [IC.music, "let-it-be.mid", true],
  [IC.file, "notes.md", false],
  [IC.file, "cover.png", false],
  [IC.folder, "drafts", false],
];

const SCENES: readonly Scene[] = [
  {
    host: [IC.bot, "Agent manager"],
    guest: [
      [IC.proto, "Prototypes"],
      `<span class="xa-set"><span class="xa-row">${bar(46)}<span class="xa-sw xa-sw-a"></span></span>` +
        `<span class="xa-row">${bar(58)}<span class="xa-sw xa-sw-b"></span></span>` +
        `<span class="xa-row">${bar(38)}<span class="xa-seg"><span class="xa-sg-a">Dense</span><span class="xa-sg-b">Airy</span></span></span></span>`,
    ],
    body: (slot) =>
      `<span class="xa-th"><span class="xa-me">Mock up a compact settings pane</span><span class="xa-ag xa-act">Here it is:</span>${slot}</span>`,
  },
  {
    host: [IC.page, "Pages"],
    // a few streets, a river, and the place's pin dropping onto them
    guest: [
      [IC.pin, "Places"],
      `<span class="xa-map"><svg viewBox="0 0 260 54" preserveAspectRatio="none" aria-hidden="true">` +
        `<path class="xa-water" d="M0 44 C60 36 110 50 170 42 S240 34 260 38 V54 H0z"/>` +
        `<path class="xa-road" d="M0 18 H260 M0 32 C80 30 160 26 260 28 M70 0 L84 54 M150 0 C146 20 150 36 156 54 M214 0 L204 54"/></svg>` +
        `<span class="xa-pin">${IC.pin}</span></span>` +
        `<span class="xa-place"><b>Time Out Market</b><span>Food hall · open until 23:00</span></span>`,
    ],
    body: (slot) =>
      `<span class="xa-doc"><span class="xa-h">Lisbon trip</span>` +
      `<span class="xa-line">Saturday lunch at <span class="xa-mention xa-act">${IC.pin}Time Out Market</span></span>${slot}${bar(64)}</span>`,
  },
  {
    host: [IC.folder, "Files"],
    guest: [
      [IC.music, "Music"],
      `<span class="xa-roll">${NOTES.map(([x, w, r]) => `<span class="xa-n" style="left:${x}%;width:${w}%;top:${r * 9 + 3}px"></span>`).join("")}` +
        `<span class="xa-head"></span></span><span class="xa-pl xa-pl-sm"><span class="xa-pb">${IC.play}</span><span class="xa-song"><b>let-it-be.mid</b><span>0:42 / 3:50</span></span></span>`,
    ],
    // the pointer that clicks the file shows in this scene's step a (state 4) only
    body: (slot) =>
      `<span class="xa-fx"><span class="xa-ls">` +
      FILES.map(
        ([ic, n, sel]) =>
          `<span class="xa-f${sel ? " xa-fsel" : ""}">${ic}<span>${n}</span></span>`,
      ).join("") +
      `</span>${slot}<span class="xa-cur" data-in="4"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1.5v8.5l2.4-2.2 1.6 3.4 1.6-.8-1.6-3.3H9z"/></svg></span></span>`,
  },
  {
    host: [IC.hammer, "Deploy"],
    guest: [[IC.bot, "Agent manager"], task("Fix the failing build")],
    body: (slot) =>
      `<span class="xa-runs">` +
      `<span class="xa-run xa-bad xa-act">${IC.x}<span>Build #212</span><span class="xa-when">failed · 2 min ago</span></span>${slot}` +
      `<span class="xa-run">${IC.ok}<span>Build #211</span><span class="xa-when">1 h ago</span></span>` +
      `<span class="xa-run">${IC.ok}<span>Build #210</span><span class="xa-when">3 h ago</span></span></span>`,
  },
];
/** Scene k's steps a and b are states 2k and 2k + 1. */
const STEP_A = 1300;
const states = (k: number) => `${2 * k} ${2 * k + 1}`;

/**
 * Cross-app integration: one app's view appearing inside another app. Each scene plays in two steps:
 *   a · the host app alone, and the one thing that happens in it that calls for the other app (an agent's reply
 *       arriving, a place mentioned, a file clicked, a build failing) — short, so it reads as the cause;
 *   b · a space opens in the host and the other app's view appears in it, outlined in accent and tagged with that
 *       app's name; the view keeps running (its own motion never stops).
 * States: 0–1 a prototype in a conversation · 2–3 a place's map (Places) in a page · 4–5 Music's player in Files'
 * preview · 6–7 the fix task in Deploy. The pills under the window replay a scene.
 */
export const crossappCard = defineCard({
  states: SCENES.length * 2,
  autoplay: {
    seq: SCENES.flatMap((_, k) => [2 * k, 2 * k + 1]),
    every: SCENES.flatMap(() => [STEP_A, 3600]),
  },
  render: () => {
    const stage = SCENES.map(
      ({ host, guest: [[icon, app], view], body }, k) => {
        const slot = `<span class="xa-hole"><span class="xa-hole-in"><span class="xa-emb"><span class="xa-tag">${icon}${app}</span>${view}</span></span></span>`;
        return `<span class="k-panel xa-win" data-in="${states(k)}"><span class="xa-bar">${host[0]}${host[1]}</span><span class="xa-body">${body(slot)}</span></span>`;
      },
    ).join("");
    const pager = SCENES.map(
      ({ host, guest: [[icon, app]] }, k) =>
        `<span class="xa-dot" data-act="go" data-v="${k}" role="button" tabindex="0" aria-label="${app} in ${host[1]}" data-on="${states(k)}">${host[0]}${icon}</span>`,
    ).join("");
    return `<span class="k-html"><span class="xa-stage">${stage}</span><span class="xa-pg">${pager}</span></span>`;
  },
  actions: {
    go: (ctx, el) => {
      const s = 2 * Number(el.dataset.v);
      ctx.hold();
      ctx.run([
        [0, s],
        [STEP_A, s + 1],
      ]);
    },
  },
});
