import type { ReactElement, ReactNode } from "react";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/** One setting of a role's card: its label, then its value. */
export function SettingRow({
  label,
  children,
  dim,
  top,
}: {
  label: string;
  children: ReactNode;
  /** The setting does not apply right now (shown, faded). */
  dim?: boolean;
  /** Label aligned to the value's first line (a multi-line value). */
  top?: boolean;
}): ReactElement {
  return (
    <Stack
      direction="row"
      gap="lg"
      align={top ? "start" : "center"}
      className={cn("border-b p-md last:border-b-0", dim && "opacity-50")}
    >
      <Text variant="caption" tone="muted" className={`w-44 ${rigidClass()}`}>
        {label}
      </Text>
      <Fill>{children}</Fill>
    </Stack>
  );
}
