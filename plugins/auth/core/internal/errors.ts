export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthNeedsConsentError extends AuthError {
  readonly providerId: string;
  readonly reason: "no-account" | "needs-reconsent" | "missing-scopes";
  readonly missingScopes?: string[];
  readonly hint?: string;

  constructor(args: {
    providerId: string;
    reason: "no-account" | "needs-reconsent" | "missing-scopes";
    missingScopes?: string[];
    hint?: string;
  }) {
    super(
      `Auth: ${args.providerId} needs consent (${args.reason})${
        args.missingScopes ? ` — missing: ${args.missingScopes.join(", ")}` : ""
      }`,
    );
    this.name = "AuthNeedsConsentError";
    this.providerId = args.providerId;
    this.reason = args.reason;
    this.missingScopes = args.missingScopes;
    this.hint = args.hint;
  }
}

export class AuthProviderUnknownError extends AuthError {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Auth: unknown provider "${providerId}"`);
    this.name = "AuthProviderUnknownError";
    this.providerId = providerId;
  }
}

export class AuthKeychainLockedError extends AuthError {
  constructor(detail?: string) {
    super(
      `Auth: OS keychain unavailable, token store disabled${detail ? ` (${detail})` : ""}`,
    );
    this.name = "AuthKeychainLockedError";
  }
}

export class AuthCredentialsMissingError extends AuthError {
  readonly providerId: string;
  constructor(providerId: string) {
    super(
      `Auth: provider "${providerId}" has no client credentials configured. Set them in Settings or via env vars.`,
    );
    this.name = "AuthCredentialsMissingError";
    this.providerId = providerId;
  }
}
