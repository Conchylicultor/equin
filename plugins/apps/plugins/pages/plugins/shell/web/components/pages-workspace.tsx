import {
  accountFirstName,
  accountInitial,
} from "@plugins/infra/plugins/host-account/core";
import { useHostAccount } from "@plugins/infra/plugins/host-account/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";

/**
 * The Pages brand mark (`Apps.App` `mark`): the user's initial in a small
 * tile — the workspace the sidebar below belongs to. Sized by the launcher
 * (`className`), so it stays the launcher's button face. Until the OS account
 * arrives the tile is a shimmer of its own shape; a failed read leaves it
 * empty, the name beside it carrying the error.
 */
export function PagesWorkspaceMark({ className }: { className?: string }) {
  const account = useHostAccount();
  const tile = cn(
    "rounded-control border border-border bg-selected",
    className,
  );
  if (account.status === "loading")
    return <Loading variant="block" className={tile} />;
  return (
    <Center
      as="span"
      axis="both"
      aria-hidden
      className={cn(tile, "text-caption font-semibold text-strong-foreground")}
    >
      {account.status === "ready" ? accountInitial(account.data) : null}
    </Center>
  );
}

/**
 * The Pages brand name (`Apps.App` `brandName`): "<first name>'s pages", from
 * the OS account (`infra/host-account`). A name-length shimmer until it
 * arrives, never a placeholder name.
 */
export function PagesWorkspaceName() {
  const account = useHostAccount();
  switch (account.status) {
    case "loading":
      return <Loading variant="block" className="h-3 w-28" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="your account"
          error={account.error}
          refetch={account.refetch}
        />
      );
    case "ready":
      return (
        <Text variant="body" tone="strong" className="font-medium">
          {`${accountFirstName(account.data)}'s pages`}
        </Text>
      );
  }
}
