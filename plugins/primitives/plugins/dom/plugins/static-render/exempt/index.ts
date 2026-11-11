import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/static-renderer.tsx"],
    kind: "sanctioned",
    reason:
      "Page-wide boot code: a static-render process IS the page, so it binds the page's live-state pipeline (ensureNotificationsClient) to its server-less transport — the pipeline whose default query cache the boot snapshot hydrates — exactly as the app root binds it to pageTransport.",
  },
] satisfies Exemptions;
