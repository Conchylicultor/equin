import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type {
  WorkspaceChoice,
  WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";
import { choiceFor, useWorkspaceCatalog } from "../internal/catalog";

const keyOf = (choice: WorkspaceChoice) =>
  choice.profile ? `scratch:${choice.profile.id}` : choice.kind;

/**
 * The task detail's control: one select over every registered workspace. Each
 * host owns the label, so this paints only the control.
 */
export function WorkspaceLaunchControl({
  value,
  onChange,
  disabled,
}: LaunchControlProps<WorkspaceSpec | null>) {
  const catalog = useWorkspaceCatalog();
  if (catalog.status === "error") throw catalog.error;
  if (catalog.status === "loading") return <Loading />;
  const choices = catalog.data;
  const current = choiceFor(choices, value);
  // base-ui resolves the collapsed trigger label from `items`.
  const items = Object.fromEntries(choices.map((c) => [keyOf(c), c.label]));
  return (
    <Select
      items={items}
      value={current ? keyOf(current) : null}
      onValueChange={(key: string | null) => {
        const choice = choices.find((c) => keyOf(c) === key);
        if (!choice) return;
        onChange(choice.spec.kind === "worktree" ? null : choice.spec);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Task workspace" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem
            key={keyOf(choice)}
            value={keyOf(choice)}
            disabled={choice.unavailable !== undefined}
          >
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
