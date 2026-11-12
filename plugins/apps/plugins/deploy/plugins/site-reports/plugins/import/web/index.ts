import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { WEBSITE_VISITOR_ERROR_KIND } from "../core";
import { WebsiteVisitorSummary } from "./components/website-visitor-summary";

export default {
  description:
    "Errors a deployed site's visitors hit, read hourly from the site's box over SSH (its mirror change stream, reduced as it arrives) into this computer's Reports as untrusted website-visitor reports (never auto-investigated, fenced as data when investigated by hand). Web half: the kind's Debug → Reports summary view — a Website visitors badge, then the site, the page and the visitor's error as plain text (never markup or a link) with the site's own occurrence count.",
  contributions: [
    Reports.KindView({
      match: WEBSITE_VISITOR_ERROR_KIND,
      component: WebsiteVisitorSummary,
    }),
  ],
} satisfies PluginDefinition;
