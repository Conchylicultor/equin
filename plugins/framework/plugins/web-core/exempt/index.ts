import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "plugin-boundaries",
    paths: ["web/__tests__/plugin-render.test.tsx"],
    kind: "sanctioned",
    reason:
      "App.tsx and its test import the generated web plugin registry directly: re-exporting it from the web-sdk barrel would pollute TSC's module graph in the server/central tsconfigs via transitive import chains.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/vite-contributions.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "networking/no-page-transport",
    paths: ["web/App.tsx"],
    kind: "sanctioned",
    reason:
      "The page root: it mounts the page's transport (<TransportProvider transport={pageTransport}>) above everything, and hoists that transport's live-state pipeline at boot.",
  },
  {
    rule: "networking/no-request-guard-capability",
    paths: ["web/install-request-guard.ts"],
    kind: "sanctioned",
    reason:
      "The app entry installs the page request guard before anything else evaluates, and registers the asset mirror's prefix (a sampler loads its samples from it by URL, with no transport to resolve an asset base over).",
  },
  {
    rule: "dom-access-safety/no-module-scope-dom",
    paths: ["web/main.tsx"],
    kind: "sanctioned",
    reason:
      'The Vite entry point: loaded by index.html\'s <script type="module"> and never imported, so no module graph (bun test, the docgen barrel walk) evaluates it. Mounting React on #root at evaluation is its whole job.',
  },
] satisfies Exemptions;
