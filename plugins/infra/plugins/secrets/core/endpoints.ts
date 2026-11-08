import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { SECRET_SCOPES, SecretMetadataSchema } from "./internal/types";

// Every body names the namespace AND its declared scope (`SecretNamespace`),
// so central decides where a value lives from the declaration, never from a
// per-call choice. The caller's namespace rides in `SECRETS_CALLER_HEADER`.
//
// `scope` is optional on the wire ONLY for a backend built before scopes
// existed (any worktree not yet rebased talks to main's central): central
// resolves an absent scope from its own record of the pre-scope instance
// namespaces (`central/internal/legacy-scope.ts`). Every current caller sends
// it — it is read off the `SecretNamespace` the ref names.
const SecretNamespaceBodySchema = z.object({
  namespace: z.string(),
  scope: z.enum(SECRET_SCOPES).optional(),
});

const SecretRefBodySchema = SecretNamespaceBodySchema.extend({
  key: z.string(),
});

const SecretSetBodySchema = SecretRefBodySchema.extend({
  value: z.string(),
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
  response: SecretMetadataSchema,
});

export const secretsList = defineEndpoint({
  route: "POST /api/secrets/list",
  internal: {
    why: "a read spelled as POST so secret names stay out of URLs and logs; server to central only",
  },
  body: SecretNamespaceBodySchema,
  response: z.object({ keys: z.array(z.string()) }),
});
