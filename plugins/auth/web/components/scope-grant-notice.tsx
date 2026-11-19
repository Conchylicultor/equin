import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { AuthAccountState } from "@plugins/auth/core";
import { Auth, type AuthScopeRequirement } from "../slots";
import { missingScopes } from "../scopes";
import { GrantAccessButton } from "./grant-access-button";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * Surfaces a "Grant access" affordance for every consumer-declared scope
 * requirement against this provider that is missing from the connected
 * account's granted scopes (and whose feature is enabled).
 */
export function ScopeGrantNotice({
  providerId,
  status,
}: {
  providerId: string;
  status: AuthAccountState;
}) {
  // Read before any early return: a hook called only on some renders breaks
  // React's hook order the render the account's kind changes.
  const contributions = Auth.ScopeRequirement.useContributions();
  // Only OAuth accounts have grantable scopes.
  if (status.kind !== "oauth2") return null;

  const reqs = contributions.filter((r) => r.providerId === providerId);
  if (reqs.length === 0) return null;

  return (
    <Stack gap="sm">
      {reqs.map((r, i) => (
        <RequirementNotice key={i} requirement={r} status={status} />
      ))}
    </Stack>
  );
}

function RequirementNotice({
  requirement,
  status,
}: {
  requirement: AuthScopeRequirement;
  status: AuthAccountState;
}) {
  // `useEnabled` presence is stable per contribution instance, so branching on
  // it here keeps both sub-components rules-of-hooks clean.
  if (requirement.useEnabled) {
    return (
      <GatedNotice
        useEnabled={requirement.useEnabled}
        requirement={requirement}
        status={status}
      />
    );
  }
  return <ActiveNotice requirement={requirement} status={status} />;
}

function GatedNotice({
  useEnabled,
  requirement,
  status,
}: {
  useEnabled: Hook<() => boolean>;
  requirement: AuthScopeRequirement;
  status: AuthAccountState;
}) {
  const enabled = useEnabled();
  if (!enabled) return null;
  return <ActiveNotice requirement={requirement} status={status} />;
}

function ActiveNotice({
  requirement,
  status,
}: {
  requirement: AuthScopeRequirement;
  status: AuthAccountState;
}) {
  // Only surface when something is actually missing. The button itself requests
  // the granted+requested union, so it never needs the missing diff.
  const missing = missingScopes(requirement.scopes, status.scopes);
  if (missing.length === 0) return null;

  const providerLabel =
    requirement.providerId.charAt(0).toUpperCase() +
    requirement.providerId.slice(1);

  return (
    <Stack direction="row" gap="sm" align="center">
      <Fill>
        <Stack gap="2xs">
          <Text as="div" variant="label" className="text-foreground">
            {requirement.reason}
          </Text>
          <Text as="div" variant="caption" className="text-muted-foreground">
            Needs additional {providerLabel} access
          </Text>
        </Stack>
      </Fill>
      <Stack direction="row" gap="sm" align="center" className={rigidClass()}>
        <GrantAccessButton
          providerId={requirement.providerId}
          scopes={requirement.scopes}
        />
      </Stack>
    </Stack>
  );
}
