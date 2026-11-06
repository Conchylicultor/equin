import { useConfig } from "@plugins/config_v2/web";
import { useAccountStatus, missingScopes } from "@plugins/auth/web";
import {
  foldResource,
  type ResourceError,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { gmailConfig } from "../../shared/config";
import { GMAIL_SCOPES, GOOGLE_PROVIDER_ID } from "../../core";

/**
 * The ONE thing standing between the user and a working Gmail connection, in
 * the order it must be resolved. Consumers branch on this instead of
 * re-deriving a precedence from the three booleans — so every Gmail surface
 * offers the same next step and `GmailAccessAction` can render it.
 */
export type GmailAccessBlocker = "disabled" | "disconnected" | "scopes";

export interface GmailAccess {
  /** Settings toggle is on. */
  enabled: boolean;
  /** A Google account is connected. */
  connected: boolean;
  /** The Gmail scope has been granted on the Google connection. */
  scopesGranted: boolean;
  /** enabled && connected && scopesGranted. */
  ready: boolean;
  /** The auth status has not arrived yet. */
  loading: boolean;
  /**
   * The auth status failed to load — whether an account is connected is
   * unknown, so neither `ready` nor a `blocker` is claimed. Null otherwise.
   */
  error: ResourceError | null;
  /** Retry the auth-status read (what an error rendering offers). */
  refetch: () => Promise<void>;
  /** The next unmet prerequisite, or null when ready (or still loading, or failed). */
  blocker: GmailAccessBlocker | null;
}

export function useGmailAccess(): GmailAccess {
  const { enabled } = useConfig(gmailConfig);
  const status = useAccountStatus(GOOGLE_PROVIDER_ID);
  const read = foldResource<
    typeof status,
    Pick<GmailAccess, "loading" | "error" | "connected" | "scopesGranted">
  >(status, {
    loading: () => ({
      loading: true,
      error: null,
      connected: false,
      scopesGranted: false,
    }),
    // A failed read claims nothing: not connected, and no blocker (the fix
    // affordance would be a guess).
    error: (error) => ({
      loading: false,
      error,
      connected: false,
      scopesGranted: false,
    }),
    // No account store on this host (no computer, e.g. a browser host): no
    // account is connected here.
    unavailable: () => ({
      loading: false,
      error: null,
      connected: false,
      scopesGranted: false,
    }),
    ready: (account) => ({
      loading: false,
      error: null,
      connected: account?.connected ?? false,
      scopesGranted:
        account !== null &&
        missingScopes([...GMAIL_SCOPES], account.scopes).length === 0,
    }),
  });
  const { loading, error, connected, scopesGranted } = read;
  const ready = enabled && connected && scopesGranted;

  // Precedence matters: enabling the toggle is what makes the scope requestable,
  // and a scope can only be granted on a connected account.
  let blocker: GmailAccessBlocker | null = null;
  if (!loading && error === null && !ready) {
    if (!enabled) blocker = "disabled";
    else if (!connected) blocker = "disconnected";
    else blocker = "scopes";
  }

  return {
    enabled,
    connected,
    scopesGranted,
    ready,
    loading,
    error,
    refetch: status.status === "unavailable" ? noRefetch : status.refetch,
    blocker,
  };
}

/** Nothing to retry: there is no account store to read here. */
async function noRefetch(): Promise<void> {}
