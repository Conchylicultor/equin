import { useAuthState } from "@plugins/auth/web";
import { GOOGLE_MAPS_PROVIDER_ID } from "@plugins/auth/plugins/google-maps/core";
import {
  foldResource,
  type ResourceError,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useMachineAvailability } from "@plugins/infra/plugins/endpoints/web";
import { setMapsBrowserConfig } from "../../core";
import { useMapsBrowserConfig } from "./use-maps-browser-config";

/**
 * What a Maps surface needs to work. The two use DIFFERENT credentials, and
 * neither implies the other:
 *
 * - `"places"` — address lookups, proxied through the server with the Places
 *   key held in the secrets store (server-only, never sent to a browser).
 * - `"map"` — the interactive live map, drawn in the browser by the Maps
 *   JavaScript API with the public browser key. It needs ONLY that key: a map
 *   can render with no Places key at all.
 */
export type MapsAccessCapability = "places" | "map";

/**
 * The ONE thing standing between the user and a working Maps capability.
 * Consumers branch on this rather than re-deriving a precedence, so every Maps
 * surface offers the same next step and the access actions can render it.
 *
 * Each arm belongs to exactly one capability:
 * - `"not-configured"` — no Places key stored (`"places"`).
 * - `"no-browser-key"` — no public browser key on this machine (`"map"`).
 */
export type MapsAccessBlocker = "not-configured" | "no-browser-key";

export interface MapsAccess {
  /** The credential this capability needs is stored. For `"places"` that is
   *  the Places key; for `"map"` it is the browser key. */
  configured: boolean;
  /** Same as `configured` — nothing else gates either capability today. */
  ready: boolean;
  /** The state the answer depends on has not arrived yet — distinct from
   *  "arrived, nothing stored". */
  loading: boolean;
  /**
   * The auth state failed to load — whether a key is configured is unknown, so
   * neither `ready` nor a `blocker` is claimed. Null otherwise.
   */
  error: ResourceError | null;
  /** Retry the auth-state read (what an error rendering offers). */
  refetch: () => Promise<void>;
  /** The next unmet prerequisite, or null when ready (or still loading, or failed). */
  blocker: MapsAccessBlocker | null;
  /**
   * Why this capability cannot be set up from here, when it cannot: its
   * credential lives on the computer and this host has none (the browser
   * demo). The surface says so instead of offering a set-up it cannot do.
   * Null otherwise.
   */
  unavailable: string | null;
}

export function useMapsAccess(capability: MapsAccessCapability): MapsAccess {
  // Both reads run on every call — hooks cannot be conditional — and each is one
  // small shared subscription, so the unused one costs nothing worth branching on.
  const places = usePlacesAccess();
  const map = useMapAccess();
  return capability === "places" ? places : map;
}

function usePlacesAccess(): MapsAccess {
  // Read the whole auth state rather than `useAccountStatus`, which answers
  // `null` for TWO different questions: "the state has not arrived yet" and
  // "the state arrived and names no such provider". Collapsing them leaves a
  // surface loading forever whenever the provider is genuinely absent — which
  // is the normal case in an agent worktree, where central runs main's code and
  // therefore does not know a provider added on a branch. The read's `status`
  // is the only honest source for "not yet" — and for "could not tell".
  //
  // For an api-key provider `connected` is true from the moment a key is stored
  // and nothing ever marks it stale — the refresh loop skips non-oauth2
  // providers. A key revoked in the Google console therefore still reads
  // "configured" here; the failure shows up as a loud PlacesApiError instead.
  const state = useAuthState();
  const read = foldResource<
    typeof state,
    Pick<MapsAccess, "loading" | "error" | "configured" | "unavailable">
  >(state, {
    loading: () => ({
      loading: true,
      error: null,
      configured: false,
      unavailable: null,
    }),
    // The Places key is in the computer's account store: no host without it
    // has one, or a way to add one.
    unavailable: (message) => ({
      loading: false,
      error: null,
      configured: false,
      unavailable: message,
    }),
    // A failed read claims nothing: not configured (no Maps call is attempted)
    // and no blocker (the setup affordance would be a guess).
    error: (error) => ({
      loading: false,
      error,
      configured: false,
      unavailable: null,
    }),
    ready: (data) => ({
      loading: false,
      error: null,
      configured: data.providers[GOOGLE_MAPS_PROVIDER_ID]?.connected ?? false,
      unavailable: null,
    }),
  });
  const { loading, error, configured, unavailable } = read;
  return {
    configured,
    ready: configured,
    loading,
    error,
    refetch: state.status === "unavailable" ? noRefetch : state.refetch,
    blocker:
      !loading && error === null && unavailable === null && !configured
        ? "not-configured"
        : null,
    unavailable,
  };
}

function useMapAccess(): MapsAccess {
  // A stored browser key is not a verified one: it cannot be checked from the
  // server (it is referrer-restricted), so a wrong key reads "configured" here
  // and fails in the renderer's `gm_authFailure` instead.
  const config = useMapsBrowserConfig();
  const configured = config.kind === "set";
  // A host without the computer draws with the key its page hands it, and
  // cannot store one: with none, it says so rather than offering a set-up.
  const writable = useMachineAvailability(setMapsBrowserConfig);
  return {
    configured,
    ready: configured,
    loading: config.kind === "loading",
    error: config.kind === "error" ? config.error : null,
    refetch: config.kind === "error" ? config.refetch : noRefetch,
    blocker: config.kind === "unset" ? "no-browser-key" : null,
    unavailable:
      config.kind === "unset" && !writable.available ? writable.message : null,
  };
}

/** Nothing to retry: the browser-config read has not failed. */
async function noRefetch(): Promise<void> {}
