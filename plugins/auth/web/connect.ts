import {
  EndpointError,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { disconnect as disconnectEndpoint } from "@plugins/auth/core";
import {
  MAIN_COMPOSITION_ID,
  namespaceFromHost,
} from "@plugins/infra/plugins/namespace/core";

/**
 * Open the OAuth popup. Returns a promise that resolves on `singularity.auth.complete`
 * postMessage from the popup, or rejects on cancellation/timeout.
 *
 * The popup loads `http://localhost:9000/api/auth/start/<provider>` (bare
 * localhost — see plan §G/M for why).
 */
export interface ConnectArgs {
  providerId: string;
  worktree: string;
  scopes?: string[];
}

export interface ConnectResult {
  ok: boolean;
  message?: string;
  identity?: { accountId: string; email?: string; displayName?: string };
}

const POPUP_FEATURES = "width=600,height=720";
const POPUP_NAME = "singularity-auth";
const MAIN_ORIGIN = "http://localhost:9000";
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

export function startConnectFlow(args: ConnectArgs): Promise<ConnectResult> {
  const url = new URL(
    `${MAIN_ORIGIN}/api/auth/start/${encodeURIComponent(args.providerId)}`,
  );
  url.searchParams.set("worktree", args.worktree);
  if (args.scopes && args.scopes.length > 0) {
    url.searchParams.set("scopes", args.scopes.join(","));
  }
  const popup = window.open(url.toString(), POPUP_NAME, POPUP_FEATURES);
  if (!popup) {
    return Promise.reject(
      new Error("Popup blocked. Allow popups for this site and try again."),
    );
  }

  return new Promise<ConnectResult>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(watchdog);
      clearTimeout(timeout);
    };

    function onMessage(event: MessageEvent) {
      if (event.origin !== MAIN_ORIGIN) return;
      const data = event.data as {
        type?: string;
        ok?: boolean;
        providerId?: string;
        message?: string;
        identity?: ConnectResult["identity"];
      };
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!data || data.type !== "singularity.auth.complete") return; // runtime guard on external postMessage data
      if (data.providerId && data.providerId !== args.providerId) return;
      cleanup();
      resolve({
        ok: !!data.ok,
        message: data.message,
        identity: data.identity,
      });
    }

    const watchdog = setInterval(() => {
      if (popup.closed) {
        cleanup();
        // Resolve as cancelled rather than reject — UI updates via the resource
        // in the success case anyway, so this codepath only matters for cancel.
        resolve({ ok: false, message: "cancelled" });
      }
    }, 500);

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth timed out"));
    }, POPUP_TIMEOUT_MS);

    window.addEventListener("message", onMessage);
  });
}

/** Disconnect `providerId`, through the caller's `fetchEndpoint` (`useFetchEndpoint()`). */
export async function disconnect(
  fetchEndpoint: FetchEndpoint,
  providerId: string,
  accountId?: string,
): Promise<void> {
  try {
    await fetchEndpoint(
      disconnectEndpoint,
      { provider: providerId },
      { body: { accountId } },
    );
  } catch (err) {
    if (err instanceof EndpointError) {
      throw new Error(
        `disconnect ${providerId}: ${err.status} ${typeof err.body === "string" ? err.body : JSON.stringify(err.body)}`,
      );
    }
    throw err;
  }
}

export function currentWorktreeName(): string {
  // The web app is served from `<namespace>.localhost:9000`. Off such a host
  // (no window, bare localhost) the main app is the right default.
  if (typeof window === "undefined") return MAIN_COMPOSITION_ID;
  return namespaceFromHost(window.location.host) ?? MAIN_COMPOSITION_ID;
}
