import { defineCard } from "../kit/types";
import "./dataview.css";

/** [title, status, priority (yours), depth] */
const TASKS = [
  ["Launch the beta", "In progress", "High", 0],
  ["Fix sign-in", "In progress", "High", 1],
  ["Write the docs", "To do", "Low", 1],
  ["Tidy settings", "Done", "Medium", 0],
] as const;
/** [from, subject, project (yours), unread] */
const MAIL = [
  ["TAP", "Flights to Lisbon", "Lisbon trip", 1],
  ["Bank", "Your statement", "Home", 0],
  ["Hotel", "Booking confirmed", "Lisbon trip", 0],
  ["Leo", "Dinner on Friday?", "Friends", 1],
  ["Shop", "Order shipped", "Home", 0],
] as const;
const PROJECTS = ["Lisbon trip", "Home", "Friends"] as const;
/** [title, composer, difficulty (yours)] */
const SONGS = [
  ["Clair de lune", "Debussy", 3],
  ["Gymnopédie 1", "Satie", 1],
  ["Nocturne", "Chopin", 2],
  ["Prelude in C", "Bach", 1],
] as const;
const stars = (n: number) => "★".repeat(n);

const cells = (list: readonly string[], mine: number) =>
  list
    .map((c, i) => `<span${i === mine ? ' class="dv-mine"' : ""}>${c}</span>`)
    .join("");
const row = (grid: string, list: readonly string[], cls = "") =>
  `<span class="dv-row${cls}" style="grid-template-columns:${grid}">${cells(list, 2)}</span>`;
const head = (grid: string, cols: readonly string[]) =>
  `<span class="dv-row dv-hd" style="grid-template-columns:${grid}">${cells(cols, 2)}</span>`;
const panel = (inner: string) => `<span class="k-panel dv-pn">${inner}</span>`;

const TG = "1fr 66px 48px";
const MG = "38px 1fr 62px";
const SG = "1fr 56px 52px";
const tasksHead = head(TG, ["Task", "Status", "Priority"]);
const mailHead = head(MG, ["From", "Subject", "Project"]);
const STATUSES = ["To do", "In progress", "Done"] as const;

/** [app, [default view name, its markup], [saved view], [secret view]] */
type View = readonly [string, string];
const APPS: readonly (readonly [string, View, View, View])[] = [
  [
    "Tasks",
    [
      "All",
      panel(
        tasksHead +
          TASKS.map(([t, s, p, d]) =>
            row(TG, [
              `<span class="dv-tree" style="--d:${d}">${d ? "" : "▾ "}${t}</span>`,
              s,
              p,
            ]),
          ).join(""),
      ),
    ],
    [
      "By status",
      panel(
        (["In progress", "To do", "Done"] as const)
          .map(
            (g) =>
              `<span class="dv-grp">${g}</span>` +
              TASKS.filter((r) => r[1] === g)
                .map(([t, s, p]) => row(TG, [t, s, p]))
                .join(""),
          )
          .join(""),
      ),
    ],
    [
      "Board",
      `<span class="dv-board">${STATUSES.map(
        (g) =>
          `<span class="dv-col"><span class="dv-grp">${g}</span>` +
          TASKS.filter((r) => r[1] === g)
            .map(
              ([t, , p]) =>
                `<span class="k-panel dv-card"><b>${t}</b><span class="dv-mine">${p}</span></span>`,
            )
            .join("") +
          `</span>`,
      ).join("")}</span>`,
    ],
  ],
  [
    "Mail",
    [
      "Inbox",
      panel(
        mailHead +
          MAIL.map(([f, s, u, un]) =>
            row(MG, [f, s, u], un ? " dv-un" : ""),
          ).join(""),
      ),
    ],
    [
      "Unread",
      panel(
        mailHead +
          MAIL.filter((r) => r[3])
            .map(([f, s, u]) => row(MG, [f, s, u], " dv-un"))
            .join(""),
      ),
    ],
    // grouped by a column the user made: mail from different senders, under the user's own projects
    [
      "By project",
      panel(
        PROJECTS.map(
          (g) =>
            `<span class="dv-grp"><span class="dv-mine">${g}</span> · ${MAIL.filter((r) => r[2] === g).length}</span>` +
            MAIL.filter((r) => r[2] === g)
              .map(([f, s, , un]) => row(MG, [f, s, ""], un ? " dv-un" : ""))
              .join(""),
        ).join(""),
      ),
    ],
  ],
  [
    "Songs",
    [
      "Library",
      `<span class="dv-gal">${SONGS.map(
        ([t, c, n]) =>
          `<span class="dv-tile"><span class="dv-art"></span><b>${t}</b><span class="dv-sub">${c}</span><span class="dv-mine">${stars(n)}</span></span>`,
      ).join("")}</span>`,
    ],
    [
      "Hardest",
      panel(
        head(SG, ["Title", "Composer", "Difficulty"]) +
          [...SONGS]
            .sort((a, b) => b[2] - a[2])
            .filter((r) => r[2] > 1)
            .map(([t, c, n]) => row(SG, [t, c, stars(n)]))
            .join(""),
      ),
    ],
    [
      "Chart",
      panel(
        `<span class="dv-chart">${SONGS.map(
          ([t, , n]) =>
            `<span class="dv-bar-l">${t}</span><span class="dv-bar" style="width:${n * 33}%"></span>`,
        ).join("")}</span>`,
      ),
    ],
  ],
];

/**
 * Every list is a view: three apps' lists wear the same chrome (saved views as tabs, columns with one the user
 * added, in accent), each opening on a different kind of view: Tasks as a tree, Mail as a table, Songs as a gallery.
 * Each app has a second view the user saved (grouped, filtered, a table), and "+ view" unlocks a third for the
 * curious (a board, mail grouped by your own projects, a chart), which autoplay never visits.
 * State = app * 3 + view (0 default · 1 saved · 2 secret). Every view is drawn once and gated; an unlocked app's
 * secret tab is revealed by a dv-u<app> class on the root.
 */
export const dataviewCard = defineCard({
  states: 9,
  autoplay: { seq: [0, 1, 3, 4, 6, 7], every: 2600 },
  render: (k) => {
    const apps = k.segmented(
      "app",
      APPS.map(([n], a) => ({
        v: a,
        label: n,
        on: `${3 * a} ${3 * a + 1} ${3 * a + 2}`,
      })),
    );
    let tabs = "";
    let views = "";
    APPS.forEach(([, ...vs], a) => {
      const tab = (v: number, cls = "") =>
        `<span class="dv-tab${cls}" data-act="view" data-v="${v}" data-app="${a}" data-on="${3 * a + v}" role="button" tabindex="0">${vs[v]?.[0] ?? ""}</span>`;
      tabs +=
        `<span class="dv-tabs" data-in="${3 * a} ${3 * a + 1} ${3 * a + 2}">${tab(0)}${tab(1)}${tab(2, " dv-secret")}` +
        `<span class="dv-add" data-act="unlock" data-app="${a}" role="button" tabindex="0">+ view</span></span>`;
      views += vs
        .map(([, html], v) => `<span data-in="${3 * a + v}">${html}</span>`)
        .join("");
    });
    return `<span class="k-html"><span class="k-ctl">${apps}</span>${tabs}${views}</span>`;
  },
  actions: {
    app: (ctx, el) => ctx.go(3 * Number(el.dataset.v)),
    view: (ctx, el) =>
      ctx.go(3 * Number(el.dataset.app) + Number(el.dataset.v)),
    unlock: (ctx, el) => {
      ctx.root.classList.add(`dv-u${el.dataset.app}`);
      ctx.go(3 * Number(el.dataset.app) + 2);
    },
  },
});
