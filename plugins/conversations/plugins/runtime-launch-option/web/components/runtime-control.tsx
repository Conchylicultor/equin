import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CONVERSATION_RUNTIMES,
  CONVERSATION_RUNTIME_IDS,
  type ConversationRuntimeId,
} from "@plugins/conversations/plugins/runtime-catalog/core";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";

export const RUNTIME_UNSET_LABEL = "Default";
const DEFAULT_KEY = "default";

/** The task detail's control: one select — the default, then every runtime. */
export function RuntimeLaunchControl({
  value,
  onChange,
  disabled,
}: LaunchControlProps<ConversationRuntimeId | null>) {
  const items: Record<string, string> = {
    [DEFAULT_KEY]: RUNTIME_UNSET_LABEL,
    ...Object.fromEntries(
      CONVERSATION_RUNTIME_IDS.map((id) => [
        id,
        CONVERSATION_RUNTIMES[id].label,
      ]),
    ),
  };
  return (
    <Select
      items={items}
      value={value ?? DEFAULT_KEY}
      onValueChange={(key: string | null) => {
        if (key === null) return;
        const runtime = CONVERSATION_RUNTIME_IDS.find((id) => id === key);
        onChange(runtime ?? null);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Task runtime" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(items).map(([key, label]) => (
          <SelectItem key={key} value={key}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
