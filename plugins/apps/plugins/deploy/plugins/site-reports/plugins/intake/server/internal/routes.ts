import { db } from "@plugins/database/server";
import {
  implement,
  rawEndpointHandler,
} from "@plugins/infra/plugins/endpoints/server";
import {
  capBodySize,
  requestClientIp,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import { createFanOutGate, ReportKind } from "@plugins/reports/server";
import { SITE_REPORT_LIMITS, siteReportsEndpoint } from "../../core";
import { createAdmissionGate } from "./admission";
import { createSiteReportsIntake } from "./intake";
import { createVisitorKey } from "./visitor-key";

// The process's one intake: its gates and its pending aggregate are in memory,
// so there is exactly one per backend.
const intake = createSiteReportsIntake({
  db,
  kinds: () => ReportKind.getContributions(),
  admission: createAdmissionGate(),
  fanOut: createFanOutGate({
    // A collapsed fingerprint is counted as a `fan-out` drop at admission; the
    // storm summary would only repeat that count, and this server has no
    // reports engine to file it to.
    onStorm: () => undefined,
  }),
  visitorKey: createVisitorKey(),
  now: () => Date.now(),
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
});

export const handleSubmitSiteReports = rawEndpointHandler(
  siteReportsEndpoint,
  capBodySize(
    SITE_REPORT_LIMITS.maxBodyBytes,
    implement(siteReportsEndpoint, ({ body, req }) =>
      intake.submit(body.reports, requestClientIp(req)),
    ),
  ),
);
