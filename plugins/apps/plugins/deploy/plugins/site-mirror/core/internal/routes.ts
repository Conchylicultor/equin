import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  base64UrlJsonParamSchema,
  type HOST_ONLY_PREFIX,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/host-only/core";
import {
  MirrorChangesPageSchema,
  MirrorChangesRequestSchema,
  MirrorCopyPageSchema,
  MirrorCopyRequestSchema,
  MirrorKeysPageSchema,
  MirrorKeysRequestSchema,
  MirrorRefusalSchema,
  MirrorRowsAnswerSchema,
  MirrorRowsRequestSchema,
} from "@plugins/database/plugins/table-mirror/core";

// The table mirror's host-only routes: a replica on this computer asks a
// deployed box for one page per SSH session (`curl` on the box's loopback
// port, through its gateway). The question is one base64url `?q=` value.

/**
 * How long an encoded question may be, in characters. A rows request carries
 * a list of keys; the transport sends as many as fit and hands the rest back
 * as `remaining` (the protocol's own "ask again"). Well under what the box's
 * HTTP server accepts in a request line (Bun: 16 KiB of headers) and one
 * argument of the remote shell.
 */
export const MIRROR_QUESTION_MAX_CHARS = 12_000;

/**
 * The most bytes one answer may carry, re-checked by the transport. A page is
 * cut by the source at the requested `maxBytes` of row JSON; the answer adds
 * its envelope — each row is a JSON string (escaped), with its key and hash —
 * so it is bounded at four times the page's byte cap.
 */
export const MIRROR_ANSWER_MAX_BYTES = 16 * 1024 * 1024;

const param = <S extends z.ZodType>(schema: S) =>
  base64UrlJsonParamSchema(schema, { maxChars: MIRROR_QUESTION_MAX_CHARS });

export const MirrorChangesAnswerSchema = z.union([
  MirrorChangesPageSchema,
  MirrorRefusalSchema,
]);
export const MirrorCopyAnswerSchema = z.union([
  MirrorCopyPageSchema,
  MirrorRefusalSchema,
]);
export const MirrorKeysAnswerSchema = z.union([
  MirrorKeysPageSchema,
  MirrorRefusalSchema,
]);
export const MirrorRowsResultSchema = z.union([
  MirrorRowsAnswerSchema,
  MirrorRefusalSchema,
]);

/** One page of the change stream after a cursor (`readMirrorChanges`). */
export const mirrorChangesEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/table-mirror/changes" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: param(MirrorChangesRequestSchema),
  response: MirrorChangesAnswerSchema,
});

/** One keyset page of a whole table — a replica's first sync (`readMirrorCopy`). */
export const mirrorCopyEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/table-mirror/copy" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: param(MirrorCopyRequestSchema),
  response: MirrorCopyAnswerSchema,
});

/** One keyset page of `(pk, h)` — reconciliation's walk (`readMirrorKeys`). */
export const mirrorKeysEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/table-mirror/keys" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: param(MirrorKeysRequestSchema),
  response: MirrorKeysAnswerSchema,
});

/** The current rows for a bounded list of keys (`readMirrorRows`). */
export const mirrorRowsEndpoint = defineEndpoint({
  route:
    "GET /api/host-only/table-mirror/rows" satisfies `GET ${typeof HOST_ONLY_PREFIX}${string}`,
  query: param(MirrorRowsRequestSchema),
  response: MirrorRowsResultSchema,
});
