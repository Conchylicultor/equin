import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  capBodySize,
  hostOnly,
  requestClientIp,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/server";
import {
  MAX_SITE_MESSAGE_BODY_BYTES,
  sendSiteMessageEndpoint,
  siteMessagesListEndpoint,
} from "../../core";
import { recordSiteMessage } from "./intake";
import { listSiteMessages } from "./list";
import { siteMessagesNotifyJob } from "./notify-job";

export const handleSendSiteMessage = capBodySize(
  MAX_SITE_MESSAGE_BODY_BYTES,
  implement(sendSiteMessageEndpoint, ({ body, req }) =>
    recordSiteMessage(
      db,
      body,
      {
        ip: requestClientIp(req),
        userAgent: req.headers.get("user-agent") ?? "",
        now: new Date(),
      },
      (messageId, tx) => siteMessagesNotifyJob.enqueue({ messageId }, { tx }),
    ),
  ),
);

export const handleListSiteMessages = hostOnly(
  implement(siteMessagesListEndpoint, ({ query }) =>
    listSiteMessages(db, query),
  ),
);
