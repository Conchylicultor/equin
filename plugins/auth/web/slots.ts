import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { ComponentType } from "react";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/primitives/plugins/live-state/web";
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
  /**
   * How the account is set up, rendered inline in its Accounts pane — there is
   * no second pane to open. Required: an account with no way to set it up is
   * an account the user cannot use.
   */
  setup: ProviderSetup;
}

/** An OAuth client config: it declares `clientId` and `clientSecret`, under these names. */
export type OAuthClientConfig = ConfigDescriptor & {
  readonly fields: Record<"clientId" | "clientSecret", unknown>;
};

/**
 * How a provider's account is set up. Each arm is rendered by the provider's
 * Accounts pane, under its header — one arm per way a credential is obtained:
 *
 * - `steps` — the provider's own guided setup (a `setup-steps` wizard), for a
 *   setup the generic arms cannot express (Google's OAuth client, the Google
 *   Maps key). It owns every write, connect included.
 * - `oauth-client` — the generic OAuth setup: open the console, copy the
 *   redirect URI, paste the client id + secret into `config`, connect.
 * - `password` — the generic username + password sign-in form; central trades
 *   them for a token and keeps only the token.
 *
 * The arm must match the central descriptor's kind (`oauth-client` an
 * `oauth2` provider, `password` a `password` one); the pane throws on a
 * mismatch, since the web side cannot read the descriptor at build time.
 */
export type ProviderSetup =
  | { kind: "steps"; component: ComponentType }
  | {
      kind: "oauth-client";
      /** The provider's client-credentials config (`clientId`, `clientSecret`). */
      config: OAuthClientConfig;
      /** Where the user creates the OAuth app ("https://www.notion.so/my-integrations"). */
      consoleUrl: string;
      /** What the console calls the app ("Notion integration"); "OAuth app" when absent. */
      appNoun?: string;
      /** One line on what to pick when creating it ("Type: Public"). */
      consoleNote?: string;
    }
  | {
      kind: "password";
      /** Label of the username field. Defaults to "Username". */
      usernameLabel?: string;
      /** When set, the form offers a "Create an account" link to it. */
      signUpUrl?: string;
    };

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
 * identity. Its row opens the account pane, which renders `setup`.
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
  /**
   * The integration's setup, rendered inline in its Accounts pane under the
   * shared header — the whole of the pane's body, where it is also managed once
   * set up.
   */
  setup: ComponentType;
  /**
   * The row's status, as a read — loading and failure are states, never a
   * guessed badge; `unavailable` when it is read off the computer
   * (`needsMachine`) and this subtree has none (the demo).
   */
  useStatus: Hook<
    () => ResourceResult<IntegrationStatus> | ResourceUnavailable
  >;
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
