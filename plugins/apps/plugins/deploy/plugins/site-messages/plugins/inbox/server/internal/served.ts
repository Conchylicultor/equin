import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { hostOnlyQueryOverSsh } from "@plugins/apps/plugins/deploy/plugins/host-query/server";
import {
  SITE_MESSAGES_PAGE_MAX,
  siteMessagesListEndpoint,
  SiteMessagesPageSchema,
} from "@plugins/apps/plugins/deploy/plugins/site-messages/plugins/intake/core";
import { deploymentSiteMessages } from "../../core";

// A snapshot external, for the reasons host-query's CLAUDE.md gives: the answer
// is the deployed site's own data with no change signal here, and the SSH
// target is resolved from Postgres inside `hostOnlyQueryOverSsh` (an
// undeclared read only `snapshot` keeps honest — sanctioned in this plugin's
// `exempt/index.ts`).
export const deploymentSiteMessagesServed = serveValue(deploymentSiteMessages, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the deployed site's messages, read over SSH from its box: visitors add them with no change signal here",
    },
  },
  loader: async ({ deploymentId }) => {
    const result = await hostOnlyQueryOverSsh(
      deploymentId,
      endpointPath(
        siteMessagesListEndpoint,
        {},
        { limit: SITE_MESSAGES_PAGE_MAX },
      ),
      SiteMessagesPageSchema,
    );
    if (result.kind === "not-found") {
      throw deploymentSiteMessages.refuse(
        "missing",
        "This deployment no longer exists.",
      );
    }
    // The box's answer, or which of SSH, the request or the answer failed.
    return result.kind === "answer" ? result.value : result;
  },
});
