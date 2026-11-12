import type { z } from "zod";
import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { hostOnlyQueryOverSsh } from "@plugins/apps/plugins/deploy/plugins/host-query/server";
import { encodeBase64UrlJson } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import type {
  MirrorFetch,
  MirrorFetchFailed,
} from "@plugins/database/plugins/table-mirror/plugins/replica/server";
import type {
  MirrorPk,
  MirrorRowsRequest,
} from "@plugins/database/plugins/table-mirror/core";
import {
  MIRROR_ANSWER_MAX_BYTES,
  MIRROR_QUESTION_MAX_CHARS,
  MirrorChangesAnswerSchema,
  MirrorCopyAnswerSchema,
  MirrorKeysAnswerSchema,
  MirrorRowsResultSchema,
  mirrorChangesEndpoint,
  mirrorCopyEndpoint,
  mirrorKeysEndpoint,
  mirrorRowsEndpoint,
} from "@plugins/apps/plugins/deploy/plugins/site-mirror/core";

/** A question too long to travel even at its smallest (one key over the bound). */
export class MirrorQuestionTooLongError extends Error {
  constructor(route: string, chars: number) {
    super(
      `site-mirror: a ${route} question is ${chars} characters encoded, over ${MIRROR_QUESTION_MAX_CHARS} — a key that long cannot be asked for over a host-only GET`,
    );
    this.name = "MirrorQuestionTooLongError";
  }
}

function encodeQuestion(route: string, question: unknown): string {
  const q = encodeBase64UrlJson(question);
  if (q.length > MIRROR_QUESTION_MAX_CHARS) {
    throw new MirrorQuestionTooLongError(route, q.length);
  }
  return q;
}

/**
 * The longest prefix of `req.pks` whose question fits the bound (at least
 * one key, else it throws): a rows request carries a list, and a GET carries
 * a bounded question. Binary search over the prefix length.
 */
export function fittingRowsRequest(req: MirrorRowsRequest): {
  req: MirrorRowsRequest;
  rest: MirrorPk[];
} {
  const fits = (n: number) =>
    encodeBase64UrlJson({ ...req, pks: req.pks.slice(0, n) }).length <=
    MIRROR_QUESTION_MAX_CHARS;
  if (fits(req.pks.length)) return { req, rest: [] };
  if (!fits(1)) {
    encodeQuestion(mirrorRowsEndpoint.route, {
      ...req,
      pks: req.pks.slice(0, 1),
    });
  }
  let lo = 1; // fits
  let hi = req.pks.length; // does not fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return {
    req: { ...req, pks: req.pks.slice(0, lo) },
    rest: req.pks.slice(lo),
  };
}

/** Each route's path, from its contract. */
const ROUTES = {
  changes: {
    route: mirrorChangesEndpoint.route,
    path: endpointPath(mirrorChangesEndpoint, {}),
  },
  copy: {
    route: mirrorCopyEndpoint.route,
    path: endpointPath(mirrorCopyEndpoint, {}),
  },
  keys: {
    route: mirrorKeysEndpoint.route,
    path: endpointPath(mirrorKeysEndpoint, {}),
  },
  rows: {
    route: mirrorRowsEndpoint.route,
    path: endpointPath(mirrorRowsEndpoint, {}),
  },
};

/**
 * How a replica reaches one deployment's box: each page one host-only GET
 * curled over SSH (`hostOnlyQueryOverSsh`; through this instance's own
 * gateway for a demo's stand-in box), its answer capped at
 * `MIRROR_ANSWER_MAX_BYTES`. Every way the read can fail before the box
 * answers is handed back as-is (`fetch-failed`), recorded on the replica.
 */
export function mirrorFetchOverSsh(deploymentId: string): MirrorFetch {
  async function ask<T>(
    route: { route: string; path: string },
    question: unknown,
    schema: z.ZodType<T>,
  ): Promise<T | MirrorFetchFailed> {
    const path = `${route.path}?q=${encodeQuestion(route.route, question)}`;
    const answer = await hostOnlyQueryOverSsh(deploymentId, path, schema, {
      maxAnswerBytes: MIRROR_ANSWER_MAX_BYTES,
    });
    if (answer.kind === "answer") return answer.value;
    return { kind: "fetch-failed", failure: answer };
  }

  return {
    changes: (req) => ask(ROUTES.changes, req, MirrorChangesAnswerSchema),
    copy: (req) => ask(ROUTES.copy, req, MirrorCopyAnswerSchema),
    keys: (req) => ask(ROUTES.keys, req, MirrorKeysAnswerSchema),
    // The keys that do not fit one question come back as `remaining`: the
    // protocol's own "ask again with these".
    rows: async (req) => {
      const { req: fitted, rest } = fittingRowsRequest(req);
      const answer = await ask(ROUTES.rows, fitted, MirrorRowsResultSchema);
      if (answer.kind !== "rows" || rest.length === 0) return answer;
      return { ...answer, remaining: [...answer.remaining, ...rest] };
    },
  };
}
