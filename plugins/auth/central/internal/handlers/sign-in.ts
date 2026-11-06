import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementCentral } from "@plugins/infra/plugins/endpoints/central";
import { signIn } from "@plugins/auth/core";
import { signInWithPassword } from "../actions";

/**
 * POST /api/auth/sign-in/:provider
 * Body: { username: string, password: string }
 *
 * A rejected sign-in is a 400 carrying the provider's own wording, which the
 * sign-in dialog shows inline.
 */
export const handleSignIn = implementCentral(
  signIn,
  async ({ params, body }) => {
    try {
      const identity = await signInWithPassword(
        params.provider,
        body.username,
        body.password,
      );
      return { ok: true as const, identity };
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
);
