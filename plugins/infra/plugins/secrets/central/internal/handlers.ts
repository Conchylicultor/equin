import { HttpError, implement } from "@plugins/infra/plugins/endpoints/core";
import { isNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  secretsGet,
  secretsSet,
  secretsDelete,
  secretsHas,
  secretsMeta,
  secretsList,
  SECRETS_CALLER_HEADER,
  type SecretScope,
} from "@plugins/infra/plugins/secrets/core";
import { InstanceWriteRefusedError } from "./layers";
import { resolveScope, ScopeMismatchError } from "./legacy-scope";
import {
  deleteLocal,
  getLocal,
  getMetadataLocal,
  hasLocal,
  listKeysLocal,
  setLocal,
  type Access,
} from "./store";

/**
 * Who asks, about which kind of namespace: the scope the namespace was declared
 * with (the body), and the caller's own namespace claim (the header — absent for
 * a process that declared none). A header that is not a namespace is a 400, not
 * an anonymous caller.
 */
function accessOf(
  req: Request,
  body: { namespace: string; scope?: SecretScope },
): Access {
  const caller = req.headers.get(SECRETS_CALLER_HEADER);
  if (caller !== null && !isNamespace(caller)) {
    throw new HttpError(
      400,
      `${SECRETS_CALLER_HEADER} "${caller}" is not a namespace.`,
    );
  }
  try {
    return { scope: resolveScope(body.namespace, body.scope), caller };
  } catch (err) {
    if (err instanceof ScopeMismatchError)
      throw new HttpError(400, err.message);
    throw err;
  }
}

/** A refused instance write is the caller's error, loud: 403 with the reason. */
async function refusable(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (err instanceof InstanceWriteRefusedError) {
      throw new HttpError(403, err.message);
    }
    throw err;
  }
}

export const handleGet = implement(secretsGet, async ({ body, req }) => {
  const value = getLocal(accessOf(req, body), body.namespace, body.key);
  return { value: value ?? null };
});

export const handleSet = implement(secretsSet, async ({ body, req }) => {
  await refusable(() =>
    setLocal(accessOf(req, body), body.namespace, body.key, body.value),
  );
});

export const handleDelete = implement(secretsDelete, async ({ body, req }) => {
  await refusable(() =>
    deleteLocal(accessOf(req, body), body.namespace, body.key),
  );
});

export const handleHas = implement(secretsHas, async ({ body, req }) => {
  return { has: hasLocal(accessOf(req, body), body.namespace, body.key) };
});

export const handleMeta = implement(secretsMeta, async ({ body, req }) => {
  return getMetadataLocal(accessOf(req, body), body.namespace, body.key);
});

export const handleList = implement(secretsList, async ({ body, req }) => {
  return { keys: listKeysLocal(accessOf(req, body), body.namespace) };
});
