import type { Report } from "@plugins/reports/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  WebsiteVisitorErrorSchema,
  websiteVisitorErrorSummary,
} from "../../core";

/**
 * One-line summary for Debug → Reports: a "Website visitors" badge, then the
 * site, page and error as plain text. Every value is a React text node —
 * never markup, never a link: the content was written by strangers' browsers.
 */
export function WebsiteVisitorSummary({ report }: { report: Report }) {
  const parsed = WebsiteVisitorErrorSchema.safeParse(report.data);
  return (
    <Cluster gap="sm">
      <Badge variant="warning">Website visitors</Badge>
      <span>
        {parsed.success
          ? `${websiteVisitorErrorSummary(parsed.data)} · ${parsed.data.siteCount.toLocaleString("en-US")}× on the site`
          : report.message}
      </span>
    </Cluster>
  );
}
