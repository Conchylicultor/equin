import {
  firstName,
  nameInitial,
} from "@plugins/infra/plugins/host-account/core";
import { useProfileName } from "@plugins/infra/plugins/host-account/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const workspaceSymbol = symbol("description");

/**
 * The Pages brand mark (`Apps.App` `mark`): the user's initial in a small
 * tile — the workspace the sidebar below belongs to; the pages glyph when the
 * user shows no name (Settings → Config). Sized by the launcher
 * (`className`), so it stays the launcher's button face. Until the name is
 * known the tile is a shimmer of its own shape; a failed read leaves it
 * empty, the name beside it carrying the error.
 */
export function PagesWorkspaceMark({ className }: { className?: string }) {
  const name = useProfileName();
  const tile = cn(
    "rounded-control border border-border bg-selected",
    className,
  );
  if (name.status === "loading")
    return <Loading variant="block" className={tile} />;
  return (
    <Center
      as="span"
      axis="both"
      aria-hidden
      className={cn(tile, "text-caption font-semibold text-strong-foreground")}
    >
      {name.status !== "ready" ? null : name.data.kind === "named" ? (
        nameInitial(name.data.name)
      ) : (
        <Icon icon={workspaceSymbol} />
      )}
    </Center>
  );
}

/**
 * The Pages brand name (`Apps.App` `brandName`): "<first name>'s pages", from
 * the user's name (`infra/host-account`'s profile name), or "My pages" when
 * the user shows no name. A name-length shimmer until it arrives, never a
 * placeholder name.
 */
export function PagesWorkspaceName() {
  const name = useProfileName();
  switch (name.status) {
    case "loading":
      return <Loading variant="block" className="h-3 w-28" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="your name"
          error={name.error}
          refetch={name.refetch}
        />
      );
    case "ready":
      return (
        <Text variant="body" tone="strong" className="font-medium">
          {name.data.kind === "named"
            ? `${firstName(name.data.name)}'s pages`
            : "My pages"}
        </Text>
      );
  }
}
