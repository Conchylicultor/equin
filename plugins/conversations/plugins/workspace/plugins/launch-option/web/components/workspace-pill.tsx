import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { WorkspaceSpec } from "@plugins/conversations/plugins/workspace/core";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";
import { choiceFor, useWorkspaceCatalog } from "../internal/catalog";
import { workspaceCard } from "./workspace-card";

export const worktreeIcon = symbol("call-split");
const scratchIcon = symbol("folder");

/**
 * The chosen workspace as the pill's text — never rendered for the default
 * worktree. The profile's label once the catalog is in; its id until then
 * (the stored value itself, not a stand-in).
 */
export function WorkspacePillValue({ value }: { value: WorkspaceSpec }) {
  const catalog = useWorkspaceCatalog();
  if (catalog.status === "error") throw catalog.error;
  const choice =
    catalog.status === "ready" ? choiceFor(catalog.data, value) : undefined;
  if (choice) return <>{choice.label}</>;
  return <>{value.kind === "scratch" ? value.profile : value.kind}</>;
}

/**
 * The menu rows: every registered workspace — the worktree, then each scratch
 * profile — one plain line each, its details in a hover card. A profile a
 * bare task cannot launch (its input has no defaults) is listed, disabled.
 */
export function WorkspacePillMenu({
  value,
  onChange,
  disabled,
}: LaunchControlProps<WorkspaceSpec | null>) {
  const catalog = useWorkspaceCatalog();
  if (catalog.status === "error") throw catalog.error;
  if (catalog.status === "loading") return <Loading />;
  const current = choiceFor(catalog.data, value);
  return (
    <>
      {catalog.data.map((choice) => (
        <PickerPill.Item
          key={choice.profile ? `scratch:${choice.profile.id}` : choice.kind}
          icon={
            <Icon
              icon={choice.profile ? scratchIcon : worktreeIcon}
              aria-hidden
              className="size-3.5 text-muted-foreground"
            />
          }
          selected={choice === current}
          note={choice.unavailable ? "needs input" : undefined}
          info={workspaceCard(choice)}
          // The worktree is the default: picking it clears the choice.
          onSelect={() =>
            onChange(choice.spec.kind === "worktree" ? null : choice.spec)
          }
          disabled={disabled || choice.unavailable !== undefined}
        >
          {choice.label}
        </PickerPill.Item>
      ))}
    </>
  );
}
