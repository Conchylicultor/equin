import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import type { HttpHandler } from "@plugins/framework/plugins/central-core/core";
import { tryGetProvider } from "../registry";
import { resolveCredentials } from "../credentials";
import {
  consumePendingState,
  exchangeCodeForToken,
  fetchIdentity,
  redirectUriFor,
} from "../oauth-flow";
import { setAccount } from "../token-store";
import { emitAuthChanged } from "../actions";

/**
 * GET /api/auth/callback/:provider?code=...&state=...
 *
 * Routed to central by the central-routes manifest. The registered redirect
 * URI is bare-localhost (Google rejects subdomains of localhost), and the
 * gateway forwards bare-localhost `/api/auth/callback/*` here regardless of
 * subdomain.
 */
export const handleOAuthCallback: HttpHandler = async (req, params) => {
  const providerId = params.provider;
  if (!providerId) return new Response("missing provider id", { status: 400 });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(
      renderResultPage({
        ok: false,
        message: `OAuth provider returned an error: ${error}`,
        openerOrigin: null,
      }),
    );
  }
  if (!code || !state) {
    return htmlResponse(
      renderResultPage({
        ok: false,
        message: "Missing code or state",
        openerOrigin: null,
      }),
    );
  }

  const pending = consumePendingState(state);
  if (!pending) {
    return htmlResponse(
      renderResultPage({
        ok: false,
        message: "OAuth state expired or unknown — please retry",
        openerOrigin: null,
      }),
    );
  }
  if (pending.providerId !== providerId) {
    return htmlResponse(
      renderResultPage({
        ok: false,
        message: "Provider mismatch in callback state",
        openerOrigin: pending.openerOrigin,
      }),
    );
  }

  const descriptor = tryGetProvider(providerId);
  if (!descriptor || !descriptor.oauth) {
    return htmlResponse(
      renderResultPage({
        ok: false,
        message: `Provider "${providerId}" not registered`,
        openerOrigin: pending.openerOrigin,
      }),
    );
  }

  try {
    const creds = await resolveCredentials(descriptor);
    const tokens = await exchangeCodeForToken({
      oauth: descriptor.oauth,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: redirectUriFor(providerId),
    });
    const identity = await fetchIdentity(descriptor.oauth, tokens.accessToken);
    await setAccount(providerId, "primary", {
      kind: "oauth2",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes ?? pending.scopes,
      idToken: tokens.idToken,
      identity,
      connectedAt: Date.now(),
      lastRefreshedAt: Date.now(),
      needsReconsent: false,
    });
    await emitAuthChanged();
    return htmlResponse(
      renderResultPage({
        ok: true,
        providerId,
        openerOrigin: pending.openerOrigin,
        identity,
      }),
    );
  } catch (err) {
    return htmlResponse(
      renderResultPage({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        openerOrigin: pending.openerOrigin,
      }),
    );
  }
};

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

interface ResultPageArgs {
  ok: boolean;
  providerId?: string;
  /** The opener's validated origin; `null` when the flow's state is unknown. */
  openerOrigin: string | null;
  identity?: { accountId: string; email?: string; displayName?: string };
  message?: string;
}

function renderResultPage(args: ResultPageArgs): string {
  const targetOrigin = args.openerOrigin ? escapeAttr(args.openerOrigin) : "*";
  const payload = {
    type: LEGACY_IDS.authCompleteMessage,
    ok: args.ok,
    providerId: args.providerId,
    accountId: args.identity?.accountId,
    identity: args.identity,
    message: args.message,
  };
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  const headline = args.ok
    ? `Connected ${args.identity?.email ?? args.identity?.displayName ?? args.providerId ?? ""}`
    : "Authorization failed";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(headline)}</title>
<style>
  body { font: 14px system-ui; padding: 32px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .ok { color: #166534; }
  .err { color: #991b1b; }
</style></head><body>
<h1 class="${args.ok ? "ok" : "err"}">${escapeHtml(headline)}</h1>
${args.message ? `<p>${escapeHtml(args.message)}</p>` : ""}
<p>You can close this window.</p>
<script>
  (function () {
    try {
      if (window.opener) {
        window.opener.postMessage(${payloadJson}, ${JSON.stringify(targetOrigin)});
      }
    } catch (e) { /* noop */ }
    setTimeout(function () {
      try { window.close(); } catch (e) {}
    }, 200);
  })();
</script>
</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[^a-z0-9-]/gi, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
