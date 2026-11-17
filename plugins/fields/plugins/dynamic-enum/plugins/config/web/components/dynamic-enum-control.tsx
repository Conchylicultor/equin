import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { DynamicEnum, type DynamicEnumOption } from "../internal/slots";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * The whole options-resolving control, as ONE element handed to the panel's
 * value cell.
 *
 * It is a COMPONENT rather than part of the field's `useShape`, and that is
 * structural rather than stylistic. The options come from a contributed HOOK
 * (`match.useOptions`), and whether there is a match is only known at render —
 * so calling it from `useShape` would be a conditional hook call in one
 * component instance, which React rejects the moment a contribution appears or
 * disappears under a mounted field. Splitting the two arms into two component
 * TYPES is what makes the transition a remount instead of a hook-order
 * violation, and that split is preserved verbatim from the renderer this
 * replaced.
 *
 * The consequence is that a dynamic enum is always the picker form, never a band
 * of radio rows: its option count is not known until after the shape has been
 * declared, and the shape is what the panel's threshold reads. A dynamic enum's
 * option set is a live catalogue (theme presets, the user's own categories),
 * which is the long half of that threshold anyway.
 */
export function DynamicEnumControl({
  field,
  value,
  onChange,
  placeholder,
}: {
  field: unknown;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const contributions = DynamicEnum.Options.useContributions();
  const match = contributions.find((c) => c.field === field);

  if (!match) {
    return (
      <Input
        keep={transient("committed on every change")}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <ResolvedEnum
      useOptions={match.useOptions}
      value={value}
      onChange={onChange}
    />
  );
}

function ResolvedEnum({
  useOptions,
  value,
  onChange,
}: {
  useOptions: Hook<() => readonly DynamicEnumOption[]>;
  value: string;
  onChange: (value: string) => void;
}) {
  const options = useOptions();
  const items = Object.fromEntries(
    options.map((opt) => [opt.value, opt.label]),
  );
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
