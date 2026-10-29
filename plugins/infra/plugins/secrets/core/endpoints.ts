import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

const SecretRefBodySchema = z.object({
  namespace: z.string(),
  key: z.string(),
});

const SecretSetBodySchema = z.object({
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
});

const SecretListBodySchema = z.object({
  namespace: z.string(),
});

export const secretsGet = defineEndpoint({
  route: "POST /api/secrets/get",
  internal: {
    why: "a read spelled as POST so secret names stay out of URLs and logs; server to central only",
  },
  body: SecretRefBodySchema,
  response: z.object({ value: z.string().nullable() }),
});

export const secretsSet = defineEndpoint({
  route: "POST /api/secrets/set",
  internal: { why: "server to central secret store, never the browser" },
  body: SecretSetBodySchema,
});

export const secretsDelete = defineEndpoint({
  route: "POST /api/secrets/delete",
  internal: { why: "server to central secret store, never the browser" },
  body: SecretRefBodySchema,
});

export const secretsHas = defineEndpoint({
  route: "POST /api/secrets/has",
  internal: {
    why: "a read spelled as POST so secret names stay out of URLs and logs; server to central only",
  },
  body: SecretRefBodySchema,
  response: z.object({ has: z.boolean() }),
});

export const secretsMeta = defineEndpoint({
  route: "POST /api/secrets/meta",
  internal: {
    why: "a read spelled as POST so secret names stay out of URLs and logs; server to central only",
  },
  body: SecretRefBodySchema,
  response: z.object({
    set: z.boolean(),
    updatedAt: z.number().optional(),
  }),
});

export const secretsList = defineEndpoint({
  route: "POST /api/secrets/list",
  internal: {
    why: "a read spelled as POST so secret names stay out of URLs and logs; server to central only",
  },
  body: SecretListBodySchema,
  response: z.object({ keys: z.array(z.string()) }),
});
