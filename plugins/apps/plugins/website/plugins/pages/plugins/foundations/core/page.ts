import { defineWebsitePage } from "@plugins/apps/plugins/website/plugins/crawlable/core";

/** The technical foundations page, at `/website/foundations`. */
export const foundationsPage = defineWebsitePage({
  path: "/website/foundations",
  title: "Foundations",
  description:
    "What equin brings on top of Claude, drawn as an iceberg: the server, database, deploys and the hundred other pieces apps reuse, and the harness that lets the app develop itself.",
});
