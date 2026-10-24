import { createHash, randomBytes } from "node:crypto";
import {
  namespaceFromHost,
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import type {
  AuthIdentity,
  OAuth2Config,
  ParsedTokenResponse,
} from "@plugins/auth/core";

const REDIRECT_HOST = "http://localhost:9000";

export function redirectUriFor(providerId: string): string {
  return `${REDIRECT_HOST}/api/auth/callback/${providerId}`;
}

export function generateNonce(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function generateCodeVerifier(): string {
  // base64url, 43 chars, RFC 7636 §4.1.
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface AuthorizeRequest {
  providerId: string;
  worktree: string;
  scopes: string[];
}

export interface PendingState {
  providerId: string;
  /**
   * The opener page's origin — the callback page's postMessage target. The
   * origin the page is really on, not one derived from its namespace: a
   * namespace answers on more than one host (main on `equin.localhost` and on
   * its own name, the old address), and the browser drops a message
   * whose target origin is not the opener's exact one.
   */
  openerOrigin: string;
  scopes: string[];
  codeVerifier?: string;
  createdAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, PendingState>();

export function recordPendingState(nonce: string, state: PendingState): void {
  pendingStates.set(nonce, state);
  // Garbage collect expired states opportunistically.
  if (pendingStates.size > 64) {
    const now = Date.now();
    for (const [k, v] of pendingStates) {
      if (now - v.createdAt > STATE_TTL_MS) pendingStates.delete(k);
    }
  }
}

export function consumePendingState(nonce: string): PendingState | undefined {
  const state = pendingStates.get(nonce);
  if (!state) return undefined;
  pendingStates.delete(nonce);
  if (Date.now() - state.createdAt > STATE_TTL_MS) return undefined;
  return state;
}

export function buildAuthorizeUrl(
  oauth: OAuth2Config,
  args: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    codeChallenge?: string;
  },
): string {
  const sep = oauth.scopeSeparator ?? " ";
  const baseParams: Record<string, string> = {
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: args.scopes.join(sep),
    state: args.state,
  };
  if (args.codeChallenge) {
    baseParams.code_challenge = args.codeChallenge;
    baseParams.code_challenge_method = "S256";
  }
  const overrides = oauth.buildAuthorizeParams?.({
    scopes: args.scopes,
    state: args.state,
    redirectUri: args.redirectUri,
    codeChallenge: args.codeChallenge,
  });
  const merged = { ...baseParams, ...(overrides ?? {}) };
  const u = new URL(oauth.authorizeUrl);
  for (const [k, v] of Object.entries(merged)) u.searchParams.set(k, v);
  return u.toString();
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

export function defaultParseTokenResponse(raw: unknown): ParsedTokenResponse {
  const r = raw as RawTokenResponse;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard on external API response
  if (!r || typeof r.access_token !== "string") {
    throw new Error("auth: token response missing access_token");
  }
  const expiresIn = typeof r.expires_in === "number" ? r.expires_in : 3600;
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes:
      typeof r.scope === "string" && r.scope.length > 0
        ? r.scope.split(/\s+/)
        : undefined,
    idToken: r.id_token,
  };
}

export async function exchangeCodeForToken(args: {
  oauth: OAuth2Config;
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier?: string;
  redirectUri: string;
}): Promise<ParsedTokenResponse> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
  };
  if (args.clientSecret) body.client_secret = args.clientSecret;
  if (args.codeVerifier) body.code_verifier = args.codeVerifier;

  const res = await fetch(args.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `auth: token endpoint ${res.status} for ${args.oauth.tokenUrl}: ${text}`,
    );
  }
  const raw = await res.json();
  return (args.oauth.parseTokenResponse ?? defaultParseTokenResponse)(raw);
}

export async function refreshAccessToken(args: {
  oauth: OAuth2Config;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<ParsedTokenResponse> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  };
  if (args.clientSecret) body.client_secret = args.clientSecret;

  const res = await fetch(args.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `auth: refresh ${res.status} for ${args.oauth.tokenUrl}: ${text}`,
    ) as Error & { status: number; responseText: string };
    err.status = res.status;
    err.responseText = text;
    throw err;
  }
  const raw = await res.json();
  const parsed = (args.oauth.parseTokenResponse ?? defaultParseTokenResponse)(
    raw,
  );
  // Some providers don't reissue refresh_token; preserve the existing one.
  if (!parsed.refreshToken) parsed.refreshToken = args.refreshToken;
  return parsed;
}

export async function fetchIdentity(
  oauth: OAuth2Config,
  accessToken: string,
): Promise<AuthIdentity> {
  return oauth.fetchIdentity(accessToken);
}

/**
 * The opener's origin, validated: it must be a host the gateway serves as the
 * claimed namespace, since the callback page posts the result there. A bundle
 * built before the `origin` param existed sends only `worktree` — it gets the
 * namespace's handed-out address, which is the opener's own unless it was
 * opened on another host of the same namespace.
 */
export function resolveOpenerOrigin(
  raw: string | null,
  worktree: Namespace,
): { kind: "ok"; origin: string } | { kind: "invalid"; message: string } {
  if (raw === null) return { kind: "ok", origin: namespaceUrl(worktree) };
  if (!URL.canParse(raw)) {
    return { kind: "invalid", message: `invalid origin query param: ${raw}` };
  }
  const parsed = new URL(raw);
  if (namespaceFromHost(parsed.host) !== worktree) {
    return {
      kind: "invalid",
      message: `origin ${raw} is not a host of the ${worktree} namespace`,
    };
  }
  return { kind: "ok", origin: parsed.origin };
}
