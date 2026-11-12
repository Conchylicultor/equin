import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import type { LiveKeyCut } from "@plugins/network/plugins/live/core";
import {
  hostOnlyQueryOverSsh,
  type HostQueryAnswer,
} from "@plugins/apps/plugins/deploy/plugins/host-query/server";
import {
  analyticsSessionCountsEndpoint,
  analyticsSessionsEndpoint,
  encodeSessionCountsQuery,
  encodeSessionsQuery,
  SessionCountsResultSchema,
  SessionsResultSchema,
  type SessionCountsResult,
  type SessionKey,
  type SessionsQuery,
  type SessionsResult,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  deploymentSessions,
  type DeploymentSessionsMeta,
  type DeploymentSessionsQuestion,
} from "../../core";

/** A page cut as collect's key: the key's parts are `[startedAt, id]`. */
export function sessionKeyOf(cut: LiveKeyCut | null): SessionKey | undefined {
  if (cut === null) return undefined;
  const [startedAt] = cut.key;
  if (typeof startedAt !== "string")
    throw new Error(
      `a sessions cut without a start instant: ${JSON.stringify(cut)}`,
    );
  return { startedAt, id: cut.id };
}

/** The box's sessions query for one question and one key range. */
export function sessionsQueryOf(
  q: DeploymentSessionsQuestion,
  range: { after: LiveKeyCut | null; until: LiveKeyCut | null; limit: number },
): SessionsQuery {
  const after = sessionKeyOf(range.after);
  const until = sessionKeyOf(range.until);
  return {
    range: q.range,
    filters: [],
    shape: q.shape,
    audience: q.audience,
    ...(after ? { after } : {}),
    ...(until ? { until } : {}),
    limit: range.limit,
  };
}

function askBox(
  deploymentId: string,
  query: SessionsQuery,
): Promise<HostQueryAnswer<SessionsResult>> {
  return hostOnlyQueryOverSsh(
    deploymentId,
    `${endpointPath(analyticsSessionsEndpoint, {})}?q=${encodeSessionsQuery(query)}`,
    SessionsResultSchema,
  );
}

/** The box's per-shape counts for one question — the whole range, whatever the shape. */
function askBoxCounts(
  q: DeploymentSessionsQuestion,
): Promise<HostQueryAnswer<SessionCountsResult>> {
  const query = { range: q.range, filters: [], audience: q.audience };
  return hostOnlyQueryOverSsh(
    q.deploymentId,
    `${endpointPath(analyticsSessionCountsEndpoint, {})}?q=${encodeSessionCountsQuery(query)}`,
    SessionCountsResultSchema,
  );
}

// A snapshot, not `db` and not "notified": the visits are the remote site's,
// arriving with every visitor, with no change signal on this side. Like the
// report (`dashboard/server/internal/served.ts`), `hostOnlyQueryOverSsh` reads
// the deployment's SSH target from Postgres inside the loader — UNDECLARED,
// and only `snapshot` keeps that honest (sanctioned in this plugin's
// `exempt/index.ts`).
export const deploymentSessionsServed = serveValue(deploymentSessions, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the deployed site's visits, read over SSH from its box: they change with every visitor and have no change signal here",
    },
  },
  loader: async (q, range) => {
    const answer = await askBox(q.deploymentId, sessionsQueryOf(q, range));
    switch (answer.kind) {
      case "not-found":
        throw deploymentSessions.refuse(
          "missing",
          "This deployment no longer exists.",
        );
      case "answer":
        if (answer.value.kind === "refused")
          throw deploymentSessions.refuse(
            "beyond-raw-window",
            `Visits are kept for ${answer.value.rawWindowDays} days.`,
          );
        return answer.value.sessions;
      case "no-ssh-key":
      case "unverified":
      case "ssh-failed":
      case "request-failed":
      case "route-missing":
      case "unreadable-answer":
        // Which of SSH, the request or the answer failed is the meta's to
        // render (typed, with what to do); a page only says it could not.
        throw deploymentSessions.refuse(
          "unreachable",
          `The box could not be read (${answer.kind}).`,
        );
    }
  },
  // The counts are over the whole range whatever the page: their own
  // question, asked once per question — never with each page, which would
  // count the whole range on every scroll step.
  meta: async (q): Promise<DeploymentSessionsMeta> => {
    const answer = await askBoxCounts(q);
    if (answer.kind === "not-found")
      throw deploymentSessions.refuse(
        "missing",
        "This deployment no longer exists.",
      );
    if (answer.kind !== "answer") return answer;
    const result = answer.value;
    return result.kind === "counts"
      ? {
          kind: "sessions",
          generatedAt: result.generatedAt,
          counts: result.counts,
        }
      : result;
  },
});
