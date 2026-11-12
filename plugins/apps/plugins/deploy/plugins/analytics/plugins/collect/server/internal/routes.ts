import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { lookupCountry } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/server";
import {
  capBodySize,
  requestClientIp,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import { MAX_COLLECT_BODY_BYTES, collectEndpoint } from "../../core";
import { recordCollect } from "./collect";

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
