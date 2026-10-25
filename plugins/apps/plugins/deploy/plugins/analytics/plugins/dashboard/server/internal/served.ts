import { serveValue } from "@plugins/network/plugins/live/server";
import { hostOnlyQueryOverSsh } from "@plugins/apps/plugins/deploy/plugins/host-query/server";
import {
  AnalyticsQueryResultSchema,
  analyticsQueryPath,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { deploymentAnalytics } from "../../core";

// A snapshot, not `db` and not "notified": the answer is the remote site's
// report, which moves with every visit and has no change signal on this side.
// Under `db` it would be labelled fresh while only an unrelated write to the
// deployment or server row re-asked the box; "notified" would claim a notifier
// nobody has. `hostOnlyQueryOverSsh` also resolves the deployment's SSH target
// from Postgres (row, server, pinned host key, key secret) — the private key
// and the pinned host key may only be read there, at SSH time, so it cannot be
// resolved outside the loader. That part is re-read on every measure with the
// report, so it is never staler than the report the snapshot already says is
// re-measured only on ask.
//
// That Postgres read is UNDECLARED: it happens inside another plugin's
// function, which `no-db-backed-notify`'s lexical scan does not follow, and
// the runtime's D5 guard skips snapshot externals. Only `snapshot` keeps it
// honest — never copy this loader into a `fixed` value. The check gap:
// task-1792607417-zpzsb4.
export const deploymentAnalyticsServed = serveValue(deploymentAnalytics, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the deployed site's report, read over SSH from its box: it changes with every visit and has no change signal here",
    },
  },
  loader: async ({ deploymentId, query }) => {
    const result = await hostOnlyQueryOverSsh(
      deploymentId,
      analyticsQueryPath(query),
      AnalyticsQueryResultSchema,
    );
    if (result.kind === "not-found") {
      throw deploymentAnalytics.refuse(
        "missing",
        "This deployment no longer exists.",
      );
    }
    // The box's answer, or which of SSH, the request or the answer failed.
    return result.kind === "answer" ? result.value : result;
  },
});
