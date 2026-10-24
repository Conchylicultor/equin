import type { HttpHandler } from "@plugins/framework/plugins/central-core/core";
import { tryGetProvider } from "../registry";
import { resolveCredentials } from "../credentials";
import {
  buildAuthorizeUrl,
  codeChallengeFor,
  generateCodeVerifier,
  generateNonce,
  recordPendingState,
  redirectUriFor,
  resolveOpenerOrigin,
} from "../oauth-flow";
import { AuthCredentialsMissingError } from "@plugins/auth/core";
import {
  asNamespace,
  isNamespace,
} from "@plugins/infra/plugins/namespace/core";

/**
 * GET /api/auth/start/:provider
 *
 * Routed to central by the gateway's central-routes manifest regardless of
 * which host the request arrived on (including bare-localhost).
 */
export const handleOAuthStart: HttpHandler = async (req, params) => {
  const providerId = params.provider;
  if (!providerId) return new Response("missing provider id", { status: 400 });
  const url = new URL(req.url);

  const descriptor = tryGetProvider(providerId);
  if (!descriptor)
    return new Response(`unknown provider: ${providerId}`, { status: 404 });
  if (descriptor.kind !== "oauth2" || !descriptor.oauth) {
    return new Response("provider does not support OAuth", { status: 400 });
  }

  let creds;
  try {
    creds = await resolveCredentials(descriptor);
  } catch (err) {
    if (err instanceof AuthCredentialsMissingError) {
      return new Response(
        renderErrorPage("Credentials not configured", err.message),
        {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
    throw err;
  }

  const worktreeParam = url.searchParams.get("worktree") ?? "";
  if (!worktreeParam) {
    return new Response("missing worktree query param", { status: 400 });
  }
  // The caller's namespace ends up as the postMessage target origin of the
  // callback page, so it is validated here rather than trusted downstream.
  if (!isNamespace(worktreeParam)) {
    return new Response(`invalid worktree query param: ${worktreeParam}`, {
      status: 400,
    });
  }
  const worktree = asNamespace(worktreeParam);
  const openerOrigin = resolveOpenerOrigin(
    url.searchParams.get("origin"),
    worktree,
  );
  if (openerOrigin.kind === "invalid") {
    return new Response(openerOrigin.message, { status: 400 });
  }
  const scopesParam = url.searchParams.get("scopes");
  const requested = scopesParam
    ? scopesParam.split(",").filter((s) => s.length > 0)
    : [];
  // Default scopes are always granted: a scoped (incremental-consent) request must
  // never drop the identity scopes the rest of the app relies on.
  const scopes = [
    ...new Set([...descriptor.oauth.defaultScopes, ...requested]),
  ];

  const nonce = generateNonce();
  const usePkce = descriptor.oauth.pkce !== false;
  const codeVerifier = usePkce ? generateCodeVerifier() : undefined;
  const codeChallenge = codeVerifier
    ? codeChallengeFor(codeVerifier)
    : undefined;

  recordPendingState(nonce, {
    providerId,
    openerOrigin: openerOrigin.origin,
    scopes,
    codeVerifier,
    createdAt: Date.now(),
  });

  const authorizeUrl = buildAuthorizeUrl(descriptor.oauth, {
    clientId: creds.clientId,
    redirectUri: redirectUriFor(providerId),
    scopes,
    state: nonce,
    codeChallenge,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl },
  });
};

function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:14px system-ui;padding:24px;color:#222} h1{font-size:18px}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<pre>${escapeHtml(detail)}</pre>
<p>Close this window and complete the setup in Singularity Settings.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
