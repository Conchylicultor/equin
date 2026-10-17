import type { CardKey } from "../cards";

/**
 * The iceberg's content: ten layers, sea level to the abyss (verbatim from the
 * prototype's data.js, whose copy rules — facts, not slogans — the
 * foundations CLAUDE.md carries).
 *
 * A piece's name says what the thing IS; its sentence says what it brings.
 * `harness` pieces shorten the loop from "you have an idea" to "it runs in
 * production"; every other piece is a component: what every app built on equin
 * gets for free. `loc` is the lines of code in the layer, which the depth gauge
 * counts down through.
 */
export interface IcebergPiece {
  name: string;
  /** 1–3: how big the pill is. */
  weight: 1 | 2 | 3;
  desc: string;
  /** The drawing the piece opens into, if any. */
  card?: CardKey;
  kind: "component" | "harness";
}

export interface IcebergLayer {
  name: string;
  tag: string;
  loc: number;
  pieces: readonly IcebergPiece[];
}

export const LAYERS: readonly IcebergLayer[] = [
  {
    name: "The apps",
    loc: 140365,
    tag: "What you see. Every one is just plugins put together.",
    pieces: [
      {
        name: "Agent manager",
        weight: 3,
        desc: "A nested todo list whose tasks are carried out by agents, each in its own copy of the app.",
        kind: "harness",
      },
      {
        name: "Pages",
        weight: 3,
        desc: "A Notion-like editor that you and your agents write in together.",
        kind: "component",
      },
      {
        name: "Prototypes",
        weight: 2,
        desc: "Design a screen as a mockup first, then compare it side by side with the real app.",
        kind: "harness",
      },
      {
        name: "Mail",
        weight: 2,
        desc: "A Gmail-class mail client.",
        kind: "component",
      },
      {
        name: "Music",
        weight: 2,
        desc: "A piano app and a chord ear trainer on their own music engine: a small language for chord charts, voicings and an audio scheduler.",
        kind: "component",
      },
      {
        name: "Deploy",
        weight: 1,
        desc: "Publish apps to remote servers, and see every build and deploy with its logs.",
        kind: "harness",
      },
      {
        name: "Events",
        weight: 1,
        desc: "Track events from many sources in one place.",
        kind: "component",
      },
    ],
  },
  {
    name: "Shell & chrome",
    loc: 34571,
    tag: "The frame around every app.",
    pieces: [
      {
        name: "Flexible layout",
        weight: 3,
        desc: "Arrange your workspace like an editor: apps open as tabs, floating windows, or columns.",
        card: "tabs",
        kind: "component",
      },
      {
        name: "Themes",
        weight: 3,
        desc: "Each app can have its own theme, from a community gallery or your own. All apps use the same components, so every theme works in every app.",
        card: "themes",
        kind: "component",
      },
      {
        name: "Custom UI",
        weight: 2,
        desc: "Add new buttons and menu items anywhere in the app, or move, hide and reorder the ones there. Each app keeps its own.",
        card: "layout",
        kind: "component",
      },
      {
        name: "Cross-app integration",
        weight: 3,
        desc: "Apps use each other directly: a page can show a live task, and a conversation opens the prototype it mentions.",
        card: "crossapp",
        kind: "component",
      },
      {
        name: "Unified notifications",
        weight: 2,
        desc: "One notification center for every app and every agent.",
        kind: "component",
      },
    ],
  },
  {
    name: "UI primitives",
    loc: 286996,
    tag: "Building blocks every app reuses.",
    pieces: [
      {
        name: "Every list is a view",
        weight: 3,
        desc: "Every list in the app is a data view, so each can be filtered, sorted and grouped, and shown as a tree, gallery, table or a custom view.",
        card: "dataview",
        kind: "component",
      },
      {
        name: "Rich text editor",
        weight: 2,
        desc: "A Notion-style editor any app can embed. Each app adds its own blocks, so a page can hold a live task, a song you can play or a map next to its text.",
        card: "richtext",
        kind: "component",
      },
      {
        name: "Clickable mentions",
        weight: 2,
        desc: "When an agent mentions a page, a prototype or a task, it becomes a chip that opens it right beside the conversation.",
        card: "mentions",
        kind: "component",
      },
      {
        name: "Charts & dashboards",
        weight: 2,
        desc: "Metrics, charts and dashboards from one short declaration.",
        kind: "component",
      },
      {
        name: "Ready-made components",
        weight: 1,
        desc: "Image viewer, diff view, date picker, command palette and dozens more, shared by every app.",
        kind: "component",
      },
    ],
  },
  {
    name: "The plugin system",
    loc: 88701,
    tag: "An abstraction above the code: a thousand small, self-contained pieces that combine together into one app.",
    pieces: [
      {
        name: "A plugin",
        weight: 3,
        desc: "One feature, one self-contained unit, containing both the client code (running in your browser) and the server code.",
        card: "plugin",
        kind: "component",
      },
      {
        name: "How plugins connect",
        weight: 2,
        desc: "Plugins use each other. A plugin can leave an open slot, like a toolbar, where other plugins add buttons without changing it.",
        card: "slots",
        kind: "component",
      },
      {
        name: "Everything is a plugin",
        weight: 3,
        desc: "The whole app, its apps, their buttons, the shell around them, the data underneath: plugins inside plugins, all the same kind of piece.",
        card: "plugtree",
        kind: "component",
      },
      {
        name: "Standalone app builds",
        weight: 3,
        desc: "Pick a subset of the plugins and ship it as a standalone app: the whole agent manager, or just the music app.",
        card: "compose",
        kind: "component",
      },
      {
        name: "Generated code map",
        weight: 2,
        desc: "A map of every plugin and what it offers is generated from the code and handed to the agent, so it sees the whole app without opening every file.",
        kind: "harness",
      },
      {
        name: "Refactoring tools",
        weight: 1,
        desc: "Move a plugin and every reference and saved setting comes with it, so restructuring stays cheap.",
        kind: "harness",
      },
      {
        name: "Incremental builds",
        weight: 1,
        desc: "Each plugin is built and cached on its own.",
        kind: "harness",
      },
    ],
  },
  {
    name: "Data in motion",
    loc: 24067,
    tag: "How data on screen stays in sync with the server.",
    pieces: [
      {
        name: "Live data",
        weight: 3,
        desc: "Every change shows in real time in every open tab. Only what changed is sent, over one connection the tabs share, so little data moves between the server and the browser.",
        card: "live",
        kind: "component",
      },
      {
        name: "Server in the browser",
        weight: 2,
        desc: "The server can be shipped along with the page and run inside the browser. An app can then be served as a plain web page, with no server to run, that works fully offline on local data.",
        card: "pageserver",
        kind: "component",
      },
      {
        name: "Optimistic updates",
        weight: 3,
        desc: "Your edit shows at once and the server confirms it after. Buttons show when they are waiting, and a cloud icon shows saving or saved.",
        card: "optimistic",
        kind: "component",
      },
      {
        name: "Windowed loading",
        weight: 2,
        desc: "Rows are loaded as you scroll, so a table of 10 million rows scrolls as fast as one of 100.",
        card: "window",
        kind: "component",
      },
      {
        name: "Draft autosave",
        weight: 2,
        desc: "What you type is saved as a draft as you go, so it is still there after a refresh, a crash or an app update.",
        kind: "component",
      },
      {
        name: "Live co-editing",
        weight: 2,
        desc: "When an agent edits a page you have open, its changes appear as it makes them.",
        kind: "component",
      },
    ],
  },
  {
    name: "Where state lives",
    loc: 49175,
    tag: "Your data, kept safe and current while agents change the app around it.",
    pieces: [
      {
        name: "Database per agent",
        weight: 3,
        desc: "Every agent gets its own copy of your data to work with, so its changes never affect the app you are using.",
        card: "forks",
        kind: "harness",
      },
      {
        name: "Safe data updates",
        weight: 2,
        desc: "When an agent adds or renames a field, your existing records are upgraded automatically as it lands.",
        card: "migrations",
        kind: "harness",
      },
      {
        name: "Markdown ↔ blocks",
        weight: 2,
        desc: "Agents read and write pages as plain markdown; it is converted to and from the structured, Notion-like blocks the page is stored as.",
        card: "blocks",
        kind: "harness",
      },
      {
        name: "Protected blocks",
        weight: 2,
        desc: "By default, agents can never edit your text. They can only comment on it.",
        card: "protected",
        kind: "harness",
      },
      {
        name: "Unified config",
        weight: 2,
        desc: "One config system across all apps, that both you and your agents can edit.",
        kind: "component",
      },
      {
        name: "Integrations & secrets",
        weight: 2,
        desc: "Connect outside services through built-in integrations, or add new ones as plugins. Sign-ins and API keys are stored encrypted.",
        kind: "component",
      },
      {
        name: "Backups",
        weight: 2,
        desc: "Your data, settings, pages, prototypes and agent conversations are automatically backed up to Google Drive or a local folder.",
        kind: "component",
      },
    ],
  },
  {
    name: "Background & reactions",
    loc: 20962,
    tag: "Work the app does on its own, without a user action.",
    pieces: [
      {
        name: "Jobs & triggers",
        weight: 3,
        desc: "A system of background tasks, started on a schedule or when an event happens.",
        card: "triggers",
        kind: "component",
      },
      {
        name: "Durable jobs",
        weight: 3,
        desc: "Work in progress keeps going when an agent's change restarts the app, and picks up where it left off.",
        card: "durable",
        kind: "component",
      },
      {
        name: "File & git watchers",
        weight: 1,
        desc: "Changes to files, git and data are pushed as they happen instead of checked on a timer, so the app does nothing when idle.",
        kind: "component",
      },
    ],
  },
  {
    name: "Watching itself",
    loc: 77444,
    tag: "Each part of the app reports what it does, so you can see what is happening without reading the code.",
    pieces: [
      {
        name: "Crash & perf reports",
        weight: 3,
        desc: "Crashes and performance issues are detected and reported automatically, so agents can fix them autonomously.",
        kind: "harness",
      },
      {
        name: "Crash isolation",
        weight: 2,
        desc: "A crash stays inside the button or section where it happened, so the rest of the screen keeps working.",
        card: "isolation",
        kind: "component",
      },
      {
        name: "Profiling",
        weight: 2,
        desc: "equin primitives are profiled out of the box, so agents can investigate performance issues.",
        card: "profiling",
        kind: "harness",
      },
      {
        name: "Background monitoring",
        weight: 3,
        desc: "Every job, timer and watcher describes in plain words what it does, and every run is recorded, so humans can monitor and trust what agents are doing.",
        card: "background",
        kind: "harness",
      },
      {
        name: "System status",
        weight: 2,
        desc: "One dot in every app shows what is wrong and how to fix it, along with running builds and deploys.",
        card: "status",
        kind: "harness",
      },
      {
        name: "Plugin explorer",
        weight: 1,
        desc: "Inspect the plugin tree.",
        kind: "harness",
      },
    ],
  },
  {
    name: "The machine",
    loc: 31788,
    tag: "Processes, addresses and the operating system.",
    pieces: [
      {
        name: "Gateway",
        weight: 3,
        desc: "One address per version of the app: it routes the traffic, starts a version on its first visit and stops it when idle.",
        card: "gateway",
        kind: "harness",
      },
      {
        name: "Central runtime",
        weight: 2,
        desc: "One process shared by every agent's copy of the app holds your sign-ins and API keys, so you sign in once and every copy is signed in.",
        card: "central",
        kind: "harness",
      },
      {
        name: "Zero-downtime restart",
        weight: 3,
        desc: "A new version replaces the old one without dropping open connections, and the screen shows data immediately.",
        card: "hotswap",
        kind: "harness",
      },
      {
        name: "Auto-deploy",
        weight: 2,
        desc: "Every push is deployed automatically: the server updates in the background and open tabs pick up the new version.",
        kind: "harness",
      },
      {
        name: "Web & desktop releases",
        weight: 2,
        desc: "Ship the app as a folder you run on any machine, or as a Mac app. It brings its own database and server, so there is nothing to install.",
        kind: "component",
      },
      {
        name: "Toolchain auto-upgrade",
        weight: 1,
        desc: "New releases of the tools it is built with are spotted, and an agent upgrades the app.",
        kind: "harness",
      },
    ],
  },
  {
    name: "The loop",
    loc: 119650,
    tag: "Agents use the app to change and deploy the app itself.",
    pieces: [
      {
        name: "Task → agent → deploy",
        weight: 3,
        desc: "A task becomes an agent, and the agent's work is live at its own address.",
        card: "loop",
        kind: "harness",
      },
      {
        name: "Isolated environment per agent",
        weight: 3,
        desc: "Every agent gets its own copy of the whole app (code, database, server) at its own address. It can break anything there without touching yours.",
        card: "envs",
        kind: "harness",
      },
      {
        name: "Improve button",
        weight: 2,
        desc: "See something to change? Say it right where you are; an agent picks it up.",
        kind: "harness",
      },
      {
        name: "Headless browser for agents",
        weight: 2,
        desc: "Tooling for agents to navigate the real app and take screenshots in a browser that runs in the background, out of your sight, so they check their own work before handing it over.",
        kind: "harness",
      },
      {
        name: "Checks, lint & guards",
        weight: 2,
        desc: "Prevent agent mistakes, so code can be trusted without being reviewed. Three complementary guards each cover a different part of an agent's work: guards the commands it runs, lint the code patterns it writes, checks the codebase as a whole.",
        card: "guards",
        kind: "harness",
      },
      {
        name: "Task dependencies",
        weight: 2,
        desc: "Tasks depend on each other; when one finishes, the next one launches automatically.",
        kind: "harness",
      },
      {
        name: "Build & merge queues",
        weight: 1,
        desc: "Builds and merges queue up, so agents never collide.",
        kind: "harness",
      },
      {
        name: "Isolated agent sessions",
        weight: 1,
        desc: "Agent sessions run outside the app, so they keep working even when equin is down.",
        card: "sessions",
        kind: "harness",
      },
      {
        name: "Agent CLI",
        weight: 1,
        desc: "A single entry point every agent is required to use to build, check and ship, so every agent runs the same steps in the same order and none can be skipped.",
        card: "cli",
        kind: "harness",
      },
    ],
  },
];
