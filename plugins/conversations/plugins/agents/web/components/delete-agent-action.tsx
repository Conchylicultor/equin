import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { deleteAgent } from "@plugins/conversations/plugins/agents/core";
import type { Agent } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");

export function DeleteAgentAction({
  row,
  hasChildren,
}: ItemActionProps<Agent>) {
  const agentId = row.id;
  const fetchEndpoint = useFetchEndpoint();
  const disabled = hasChildren;
  const title = disabled
    ? "Delete (only leaf agents can be deleted)"
    : "Delete agent";

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    await fetchEndpoint(deleteAgent, { id: agentId });
  };

  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={deleteIcon}
        label="Delete agent"
        tooltip={title}
        onClick={onClick}
        disabled={disabled}
        variant="ghost"
        className={disabled ? "cursor-not-allowed opacity-30" : undefined}
      />
    </ControlSizeProvider>
  );
}
