import { useState } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import {
  currentWorktreeName,
  notGrantedWarning,
  startConnectFlow,
} from "../connect";
import { useTransport } from "@plugins/primitives/plugins/networking/web";

/**
 * Reusable "Grant access" affordance for an OAuth provider + scope set.
 *
 * Asks only for `scopes`: central's start adds every scope the account
 * already holds, so the callback's full-replace of stored scopes can't drop
 * the ones the rest of the app relies on.
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
  const transport = useTransport();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleGrant() {
    setBusy(true);
    try {
      const result = await startConnectFlow(transport, {
        providerId,
        worktree: currentWorktreeName(),
        scopes,
      });
      const warning = notGrantedWarning(result);
      if (warning) {
        toast({
          type: "auth",
          category: "other",
          ...warning,
          variant: "warning",
        });
      } else if (result.ok) {
        toast({
          type: "auth",
          category: "other",
          title: "Access granted",
          description: label,
          variant: "success",
        });
      } else if (result.message && result.message !== "cancelled") {
        toast({
          type: "auth",
          category: "other",
          title: "Failed to grant access",
          description: result.message,
          variant: "error",
        });
      }
    } catch (err) {
      toast({
        type: "auth",
        category: "other",
        title: "Failed to grant access",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant={variant} loading={busy} onClick={handleGrant}>
      {label}
    </Button>
  );
}
