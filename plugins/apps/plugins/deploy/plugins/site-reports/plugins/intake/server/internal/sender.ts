import { isBotUserAgent } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import type { SiteReportSender } from "./intake";

/**
 * Who sent a batch: a crawler or HTTP library by its user agent (the rule
 * analytics counts visits by), a page under automation by its own word
 * (`navigator.webdriver`, sent as the body's `automated`), else a visitor. A
 * bot that lies about both is a visitor here — the admission budgets still
 * bound it. PURE: the user agent is read, never kept.
 */
export function siteReportSender(input: {
  ip: string;
  userAgent: string;
  automated: boolean;
}): SiteReportSender {
  if (isBotUserAgent(input.userAgent)) return { kind: "bot" };
  if (input.automated) return { kind: "automated" };
  return { kind: "visitor", ip: input.ip };
}
