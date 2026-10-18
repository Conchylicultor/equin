import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { PaneObject } from "@plugins/primitives/plugins/pane/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";

export interface AuthProviderContribution {
  id: string;
  name: string;
  icon: IconRef;
  /**
   * The service the Accounts list groups this row under ("Google Maps"), so a
   * provider and the integrations of the same service sit together. Defaults
   * to `name`.
   */
  service?: string;
  /** One line on what connecting it unlocks — the row's subtitle until an identity is known. */
  description?: string;
  /** Optional setup help text shown when credentials are missing. */
  helpUrl?: string;
  /**
   * The setup pane the provider pane's "Configure credentials" / "Add key"
   * button opens (a param-less pane, pushed to the right of the provider
   * pane); Settings → Config when absent. A pane rather than a callback, so the
   * button can hand it out as a link — ⌘/middle-click opens it in a browser tab.
   */
  credentialsPane?: PaneObject;
  /**
   * Wording for the sign-in dialog of a `kind: "password"` provider. Optional —
   * the dialog works without it. Presentational, like `helpUrl`: the exchange
   * itself lives in the central descriptor.
   */
  passwordSignIn?: {
    /** Label of the username field. Defaults to "Username". */
    usernameLabel?: string;
    /** When set, the dialog offers a "Create an account" link to it. */
    signUpUrl?: string;
  };
}

/** What an Accounts row says about its integration: a badge, and optionally the row's subtitle. */
export interface IntegrationStatus {
  tone: BadgeVariant;
  /** The badge text ("Connected", "Not set up"). */
  label: string;
  /** Replaces the row's description as its subtitle (the signed-in identity). */
  summary?: string;
}

/**
 * A setup surface listed in the Accounts pane that is not an auth provider of
 * its own — a second key of a service (the Google Maps live map), a signing
 * identity. Its row opens `pane`, pushed to the right of the Accounts list.
 */
export interface AuthIntegrationContribution {
  /** Unique among providers and integrations. */
  id: string;
  name: string;
  icon: IconRef;
  /** The service the row is grouped under (see `AuthProviderContribution.service`). */
  service: string;
  /** One line on what it unlocks. */
  description: string;
  /** The param-less pane the row opens, declared with `parent: accountsRoute`. */
  pane: PaneObject;
  /** The row's status, as a read — loading and failure are states, never a guessed badge. */
  useStatus: Hook<() => ResourceResult<IntegrationStatus>>;
}

export interface AuthScopeRequirement {
  providerId: string;
  scopes: string[];
  reason: string;
  useEnabled?: Hook<() => boolean>;
}

export const Auth = {
  /**
   * Provider sub-plugins contribute here so the Accounts pane knows about them.
   * The web-side contribution is purely presentational; provider behavior
   * (OAuth URLs, identity fetch) lives in the server-side descriptor.
   */
  Provider: defineSlot<AuthProviderContribution>({
    docLabel: (p) => p.name,
  }),
  /**
   * Consumer plugins declare the OAuth scopes they need from a provider here.
   * The Accounts pane aggregates requirements per provider, diffs against the
   * granted scopes, and surfaces a "Grant access" affordance for missing ones.
   */
  /**
   * Setup surfaces that are not providers (see `AuthIntegrationContribution`);
   * the Accounts list shows them beside the providers, grouped by service.
   */
  Integration: defineSlot<AuthIntegrationContribution>({
    docLabel: (i) => i.name,
  }),
  ScopeRequirement: defineSlot<AuthScopeRequirement>({
    docLabel: (r) => r.reason,
  }),
};
