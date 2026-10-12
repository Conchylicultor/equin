import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { PaneObject } from "@plugins/primitives/plugins/pane/web";

export interface AuthProviderRowProps {
  providerId: string;
}

export interface AuthProviderContribution {
  id: string;
  name: string;
  icon: IconRef;
  /** Optional override for the per-provider row in the Accounts pane. */
  rowComponent?: ComponentType<AuthProviderRowProps>;
  /** Optional setup help text shown when credentials are missing. */
  helpUrl?: string;
  /**
   * The pane the default row's "Configure credentials" / "Add key" button
   * links to (a param-less setup pane, opened as a fresh route); Settings →
   * Config when absent. A pane rather than a callback, so the row can hand it
   * out as a link — ⌘/middle-click opens it in a browser tab.
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
  ScopeRequirement: defineSlot<AuthScopeRequirement>({
    docLabel: (r) => r.reason,
  }),
};
