/**
 * The vision, in six chapters — one zoom-out frame each, from a single idea to
 * apps shared between people. The page's copy, from the prototype verbatim.
 * `before` / `after`: how it was, and how it is now (a chapter with no
 * `before` shows only how it is now).
 */
export interface Chapter {
  /** The chapter's reach-analytics key: `vision/<key>`. */
  key: "idea" | "app" | "integrate" | "os" | "share" | "every";
  /** Short, for the layer strip. */
  name: string;
  title: string;
  before: string;
  after: string;
  /** A chapter not built yet, drawn as a chip after its title. */
  status?: "planned" | "future";
}

export const LADDER: readonly Chapter[] = [
  {
    key: "idea",
    name: "An idea",
    title: "It all starts with an idea.",
    before:
      "Software development was expensive. Building an idea only paid off if it reached hundreds of users.",
    after:
      "That's not true anymore. There's no more friction between an idea and its realization: a missing feature, or a whole new app.",
  },
  {
    key: "app",
    name: "Ideas change the app",
    title: "Ideas change the app as you use it.",
    before:
      "Apps were static. To update one, you left it for your agent manager, prompted it, waited for the fix and redeployed by hand.",
    after:
      "Now you reshape the app directly from the app itself, while you are using it.",
  },
  {
    key: "integrate",
    name: "Apps integrate",
    title: "All apps integrate with each other.",
    before:
      "Each surface was a different application: Gmail, GitHub, Claude Desktop, Notion. They talked through APIs, but there was no real integration.",
    after:
      "Now everything lives on a single surface and links natively: a page embeds a place, a conversation opens on the side, a file opens in its player.",
  },
  {
    key: "os",
    name: "A personal OS",
    title: "All your apps, packaged as a personal OS.",
    before: "",
    after:
      "Your apps form one coherent system: the same building blocks, the same data, one surface.",
  },
  {
    key: "share",
    name: "Shared",
    status: "planned",
    title: "Apps and building blocks, shared.",
    before:
      "Even with agents, building a full app from scratch is still not free.",
    after:
      "Instead, people reuse the apps others share, tweak them, or share their own.",
  },
  {
    key: "every",
    name: "Every app",
    status: "future",
    title: "Every app, rebuilt.",
    before: "",
    after:
      "Every legacy application eventually gets replaced. Legacy services keep serving the data, but each user sees it through their own custom interface.",
  },
];
