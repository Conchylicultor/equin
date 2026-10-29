import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { effects, patchValue } from "@plugins/network/plugins/live/core";
import {
  configConflict,
  configScopes,
  configTiers,
  configValues,
} from "./resource";

// The document tuple a write names: `{ path }` for the base, `{ path, scopeId }`
// for a scope — the params of `configValues` / `configTiers`.
function documentOf(body: { storePath: string; scopeId?: string }): {
  path: string;
  scopeId?: string;
} {
  return body.scopeId
    ? { path: body.storePath, scopeId: body.scopeId }
    : { path: body.storePath };
}

export const setConfigField = defineEndpoint({
  route: "POST /api/config-v2/set-field",
  // The field now holds the written value, supplied by the user layer. A scope
  // with no config of its own yet is not a tuple anyone reads (reads fall to the
  // base document until the server forks it), so its patch changes nothing shown.
  effect: (on) =>
    effects(
      patchValue(
        on,
        configValues,
        ({ body }) => documentOf(body),
        (doc, { body }) => ({ ...doc, [body.key]: body.value }),
      ),
      patchValue(
        on,
        configTiers,
        ({ body }) => documentOf(body),
        (tiers, { body }) => ({ ...tiers, [body.key]: "user" }),
      ),
      // A hash conflict shows the editor the OVERRIDE document, which the write
      // edits; the resolved values above stay the server's to move.
      patchValue(
        on,
        configConflict,
        ({ body }) => documentOf(body),
        (conflict, { body }) =>
          conflict?.kind === "hash"
            ? {
                ...conflict,
                overrideValues: {
                  ...conflict.overrideValues,
                  [body.key]: body.value,
                },
              }
            : conflict,
      ),
    ),
  agentReverted: true,
  body: z.object({
    storePath: z.string(),
    key: z.string(),
    value: z.unknown(),
    scopeId: z.string().optional(),
  }),
});

export const forkScope = defineEndpoint({
  route: "POST /api/config-v2/fork-scope",
  unpredicted: {
    reason: "server-decided",
    why: "forks every descriptor the server marks scope: \"app\" — a set only the server's registry knows — and snapshots each one's current document",
  },
  agentReverted: true,
  body: z.object({ scopeId: z.string() }),
});

export const deleteScope = defineEndpoint({
  route: "POST /api/config-v2/delete-scope",
  unpredicted: {
    reason: "server-decided",
    why: "drops the scope from every descriptor that has it — which ones the server's registry decides",
  },
  agentReverted: true,
  body: z.object({ scopeId: z.string() }),
});

// Per-descriptor scope primitives (single descriptor × scope), distinct from
// fork-scope/delete-scope which act over the whole `scope: "app"` set. Used by
// the settings detail pane to add / stop a per-app customization for one
// descriptor.
export const forkDescriptorScope = defineEndpoint({
  route: "POST /api/config-v2/fork-descriptor-scope",
  // The scope joins the descriptor's customized scopes. (Its own document is the
  // server's snapshot of the base — not a tuple anyone holds yet.)
  effect: (on) =>
    patchValue(
      on,
      configScopes,
      () => ({}),
      (map, { body }) => {
        const held = map[body.storePath] ?? [];
        return held.includes(body.scopeId)
          ? map
          : { ...map, [body.storePath]: [...held, body.scopeId] };
      },
    ),
  agentReverted: true,
  body: z.object({ storePath: z.string(), scopeId: z.string() }),
});

export const removeDescriptorScope = defineEndpoint({
  route: "POST /api/config-v2/remove-descriptor-scope",
  effect: (on) =>
    patchValue(
      on,
      configScopes,
      () => ({}),
      (map, { body }) => ({
        ...map,
        [body.storePath]: (map[body.storePath] ?? []).filter(
          (scopeId) => scopeId !== body.scopeId,
        ),
      }),
    ),
  agentReverted: true,
  body: z.object({ storePath: z.string(), scopeId: z.string() }),
});
