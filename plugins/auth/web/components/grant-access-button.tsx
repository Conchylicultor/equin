import { useState } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useAccountStatus } from "../hooks";
import { currentWorktreeName, startConnectFlow } from "../connect";
import { mergeScopes } from "../scopes";

/**
 * Reusable "Grant access" affordance for an OAuth provider + scope set.
 *
 * Requests the UNION of already-granted + requested scopes so the OAuth
 * callback's full-replace of stored scopes can't drop scopes the rest of the
 * app relies on.
 */
export function GrantAccessButton(props: {
  providerId: string;
  scopes: string[];
  label?: string;
  variant?: "default" | "outline";
}) {
  const {
    providerId,
    scopes,
    label = "Grant access",
    variant = "outline",
  } = props;
  const toast = useToast();
  const status = useAccountStatus(providerId);
  const [busy, setBusy] = useState(false);
  // The already-granted scopes, once known (`[]`-equivalent `undefined` when
  // the provider has no account). Until then the union cannot be computed —
  // and granting without it would let the callback's full-replace DROP scopes —
  // so the button waits (disabled) and a failed read offers its Retry instead.
  const grantedScopes = foldResource(status, {
    loading: () => null,
    error: () => null,
    ready: (account) => account?.scopes,
  });

  async function handleGrant() {
    setBusy(true);
    try {
      const result = await startConnectFlow({
        providerId,
        worktree: currentWorktreeName(),
        scopes: mergeScopes(grantedScopes ?? undefined, scopes),
      });
      if (result.ok) {
        toast({
          type: "auth",
          title: "Access granted",
          description: label,
          variant: "success",
        });
      } else if (result.message && result.message !== "cancelled") {
        toast({
          type: "auth",
          title: "Failed to grant access",
          description: result.message,
          variant: "error",
        });
      }
    } catch (err) {
      toast({
        type: "auth",
        title: "Failed to grant access",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  if (status.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the account's granted scopes"
        error={status.error}
        refetch={status.refetch}
      />
    );

  return (
    <Button
      variant={variant}
      loading={busy}
      disabled={status.status === "loading"}
      onClick={handleGrant}
    >
      {label}
    </Button>
  );
}
