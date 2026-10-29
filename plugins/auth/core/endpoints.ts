import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { AuthIdentitySchema, AuthStateValueSchema } from "./resources";

export const DisconnectBodySchema = z.object({
  accountId: z.string().optional(),
});
export type DisconnectBody = z.infer<typeof DisconnectBodySchema>;

// Discriminated union mirroring TokenResponse (token-types.ts) on the wire.
const TokenResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    accessToken: z.string(),
    expiresAt: z.number(),
    scopes: z.array(z.string()),
    identity: AuthIdentitySchema,
  }),
  z.object({
    ok: z.literal(false),
    needsConsent: z.literal(true),
    reason: z.enum(["no-account", "needs-reconsent", "missing-scopes"]),
    missingScopes: z.array(z.string()).optional(),
  }),
  z.object({
    ok: z.literal(false),
    needsConsent: z.literal(false).optional(),
    message: z.string(),
    code: z.string().optional(),
  }),
]);

export const SetApiKeyBodySchema = z.object({
  apiKey: z.string(),
});
export type SetApiKeyBody = z.infer<typeof SetApiKeyBodySchema>;

// The password crosses browser → gateway → central once, in this body. Central
// trades it for the provider's token and drops it — never stored, never logged.
export const SignInBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type SignInBody = z.infer<typeof SignInBodySchema>;

export const GetTokenBodySchema = z.object({
  providerId: z.string(),
  accountId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});
export type GetTokenBody = z.infer<typeof GetTokenBodySchema>;

// OAuth start/callback return HTML/redirects — raw handlers
// (`rawEndpointHandler`), not implement(), so the declaration (the callback's
// `access`) still rides on the handler.

/** Owner-only: the popup opens it at the page's own origin (same-origin). */
export const oauthStart = defineEndpoint({
  route: "GET /api/auth/start/:provider",
});

/**
 * Public: the provider redirects the popup here — a cross-site navigation,
 * so the gateway's verdict is anonymous. It acts only on a `state` nonce that
 * an owner request to {@link oauthStart} minted (and consumes it once).
 */
export const oauthCallback = defineEndpoint({
  route: "GET /api/auth/callback/:provider",
  access: {
    public: "authenticated by the OAuth state nonce an owner request minted",
  },
});

export const disconnect = defineEndpoint({
  route: "POST /api/auth/disconnect/:provider",
  unpredicted: {
    reason: "server-decided",
    why: "central revokes the connection with the provider before dropping it, so the outcome is not known from the request",
  },
  body: DisconnectBodySchema,
});

export const setApiKey = defineEndpoint({
  route: "POST /api/auth/api-key/:provider",
  unpredicted: {
    reason: "server-decided",
    why: "the provider's API verifies the key before the identity is stored",
  },
  body: SetApiKeyBodySchema,
  response: z.object({ ok: z.literal(true), identity: AuthIdentitySchema }),
});

export const signIn = defineEndpoint({
  route: "POST /api/auth/sign-in/:provider",
  unpredicted: {
    reason: "precondition",
    why: "credentials are judged server-side and a rejection shows inline in the sign-in form",
  },
  body: SignInBodySchema,
  response: z.object({ ok: z.literal(true), identity: AuthIdentitySchema }),
});

export const getAuthState = defineEndpoint({
  route: "GET /api/auth/state",
  response: AuthStateValueSchema,
});

export const getToken = defineEndpoint({
  route: "POST /api/auth/token",
  internal: {
    why: "server to central token fetch, never called from the browser",
  },
  body: GetTokenBodySchema,
  response: TokenResponseSchema,
});
