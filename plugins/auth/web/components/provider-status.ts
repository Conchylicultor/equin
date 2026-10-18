import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { AuthAccountState } from "@plugins/auth/core";
import { useAuthState } from "../hooks";
import type { IntegrationStatus } from "../slots";

/**
 * A provider's Accounts status, as a read. Central not knowing the provider is
 * its own answer ("Unavailable"), not a missing value: normal in an agent
 * worktree, since central runs main's code and does not know a provider added
 * on a branch.
 */
export function useProviderStatus(
  providerId: string,
): ResourceResult<IntegrationStatus> {
  return mapResource(useAuthState(), (state) => {
    const status = state.providers[providerId];
    return status
      ? accountStatus(status)
      : { tone: "muted", label: "Unavailable" };
  });
}

/** One arm per kind, so a new kind is a type error here. */
export function accountStatus(status: AuthAccountState): IntegrationStatus {
  const who = status.identity?.email ?? status.identity?.displayName;
  const summary = status.connected && who ? { summary: who } : {};
  switch (status.kind) {
    case "apikey":
      // `credentialsConfigured` is hardcoded `true` for every non-oauth2 provider
      // (auth/central/internal/auth-state.ts), so "Setup required" can never fire
      // here. Whether a key has been stored is the only real signal.
      return status.connected
        ? { tone: "success", label: "Connected", ...summary }
        : { tone: "muted", label: "Not set up" };
    case "password":
      // Same single signal as an api key: whether a sign-in token is stored.
      return status.connected
        ? { tone: "success", label: "Connected", ...summary }
        : { tone: "muted", label: "Not signed in" };
    case "oauth2":
      if (!status.credentialsConfigured) {
        return { tone: "muted", label: "Setup required" };
      }
      if (status.needsReconsent) {
        return { tone: "warning", label: "Needs reconsent", ...summary };
      }
      if (status.connected) {
        return { tone: "success", label: "Connected", ...summary };
      }
      return { tone: "muted", label: "Disconnected" };
    default: {
      const unknownKind: never = status.kind;
      throw new Error(`auth: unhandled provider kind "${String(unknownKind)}"`);
    }
  }
}
