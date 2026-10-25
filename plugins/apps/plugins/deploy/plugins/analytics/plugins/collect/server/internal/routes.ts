import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { lookupCountry } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/server";
import {
  capBodySize,
  hostOnly,
  requestClientIp,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import {
  MAX_COLLECT_BODY_BYTES,
  analyticsQueryEndpoint,
  collectEndpoint,
} from "../../core";
import { recordCollect } from "./collect";
import { runAnalyticsQuery } from "./report";

export const handleCollect = capBodySize(
  MAX_COLLECT_BODY_BYTES,
  implement(collectEndpoint, ({ body, req }) =>
    recordCollect(
      db,
      body,
      {
        ip: requestClientIp(req),
        userAgent: req.headers.get("user-agent") ?? "",
        acceptLanguage: req.headers.get("accept-language"),
        now: new Date(),
      },
      lookupCountry,
    ),
  ),
);

export const handleAnalyticsQuery = hostOnly(
  implement(analyticsQueryEndpoint, ({ query }) =>
    runAnalyticsQuery(db, query.q, new Date()),
  ),
);
