import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  wholeList,
  wholeRecord,
} from "@plugins/packages/plugins/list-bound/core";
import {
  AUTH_PROVIDER_KINDS,
  type AuthIdentity,
  type AuthStateValue,
  type AuthAccountState,
} from "./internal/lib";

export const AuthIdentitySchema = z.object({
  accountId: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
}) satisfies z.ZodType<AuthIdentity>;

const AuthAccountStateSchema = z.object({
  connected: z.boolean(),
  kind: z.enum(AUTH_PROVIDER_KINDS),
  credentialsConfigured: z.boolean(),
  identity: AuthIdentitySchema.optional(),
  scopes: wholeList(z.string(), {
    reason: "the OAuth scopes one account granted — a handful per provider",
  }).optional(),
  needsReconsent: z.boolean().optional(),
  connectedAt: z.number().optional(),
  lastRefreshError: z
    .object({ message: z.string(), at: z.number() })
    .optional(),
}) satisfies z.ZodType<AuthAccountState>;

export const AuthStateValueSchema = z.object({
  mainOffline: z.boolean().optional(),
  providers: wholeRecord(AuthAccountStateSchema, {
    reason: "one entry per registered auth provider — tens at most",
  }),
}) satisfies z.ZodType<AuthStateValue>;

/**
 * The shared auth state. `origin: "central"`: auth tokens live on the central
 * runtime, shared across all worktrees, so the browser subscribes via
 * `/ws/central-notifications` and only `network/live/central`'s `serveValue`
 * can serve it.
 */
export const authState = liveValue("auth-state", {
  schema: AuthStateValueSchema,
  origin: "central",
});
