import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import {
  CONVERSATION_RUNTIMES,
  CONVERSATION_RUNTIME_IDS,
  type ConversationRuntimeId,
} from "@plugins/conversations/plugins/runtime-catalog/core";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";
import { RUNTIME_UNSET_LABEL } from "./runtime-control";

/** The picked runtime as the pill's text — never rendered for the default. */
export function RuntimePillValue({ value }: { value: ConversationRuntimeId }) {
  return <>{CONVERSATION_RUNTIMES[value].label}</>;
}

/** The menu rows: the configured default, then every runtime. */
export function RuntimePillMenu({
  value,
  onChange,
  disabled,
}: LaunchControlProps<ConversationRuntimeId | null>) {
  return (
    <>
      <PickerPill.Item
        selected={value == null}
        onSelect={() => onChange(null)}
        disabled={disabled}
      >
        {RUNTIME_UNSET_LABEL}
      </PickerPill.Item>
      {CONVERSATION_RUNTIME_IDS.map((id) => (
        <PickerPill.Item
          key={id}
          selected={value === id}
          onSelect={() => onChange(id)}
          disabled={disabled}
        >
          {CONVERSATION_RUNTIMES[id].label}
        </PickerPill.Item>
      ))}
    </>
  );
}
