import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { AuthAccountState, AuthStateValue } from "@plugins/auth/core";
import { authState } from "@plugins/auth/core";

export function useAuthState(): ResourceResult<AuthStateValue> {
  return useLive(authState);
}

/**
 * One provider's account state, as a read: loading until the auth state
 * arrives, error when it could not be read, and on the ready arm the account
 * state — or `null` when the auth state arrived and names no such provider
 * (normal in an agent worktree: central runs main's code, so it does not know
 * a provider added on a branch). The three are never the same value, so a
 * failed read cannot pass for "no account".
 */
export function useAccountStatus(
  providerId: string,
): ResourceResult<AuthAccountState | null> {
  return mapResource(
    useAuthState(),
    (state) => state.providers[providerId] ?? null,
  );
}
