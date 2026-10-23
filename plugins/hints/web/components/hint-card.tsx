import type { ReactNode } from "react";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

export interface HintCardAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface HintCardProps {
  readonly title: ReactNode;
  readonly body: ReactNode;
  /** A tour's progress: one dot per step, `index` filled. */
  readonly steps?: { readonly count: number; readonly index: number };
  readonly onClose?: () => void;
  readonly alt?: HintCardAction;
  readonly onBack?: () => void;
  readonly primary?: HintCardAction;
}

/**
 * The content of every hint card — a tip, a tour step, the welcome card:
 * title (with ×), body, then a footer of step dots and the buttons. It draws
 * no chrome: the floating surface (or the welcome panel) around it does.
 */
export function HintCard({
  title,
  body,
  steps,
  onClose,
  alt,
  onBack,
  primary,
}: HintCardProps) {
  const hasFooter = steps || alt || onBack || primary;
  return (
    <ControlSizeProvider size="sm">
      <Stack gap="sm">
        <Stack direction="row" gap="sm" align="start">
          <Fill>
            <Text variant="subheading" tone="strong">
              {title}
            </Text>
          </Fill>
          {onClose && (
            <IconButton icon={closeIcon} label="Close" onClick={onClose} />
          )}
        </Stack>
        <Text as="div" variant="body" tone="muted">
          {body}
        </Text>
        {hasFooter && (
          <Stack direction="row" gap="xs" align="center">
            {steps && <StepDots {...steps} />}
            <Fill />
            {alt && (
              <Button variant="ghost" onClick={alt.onClick}>
                {alt.label}
              </Button>
            )}
            {onBack && (
              <Button variant="outline" onClick={onBack}>
                Back
              </Button>
            )}
            {primary && (
              <Button onClick={primary.onClick}>{primary.label}</Button>
            )}
          </Stack>
        )}
      </Stack>
    </ControlSizeProvider>
  );
}

function StepDots({ count, index }: { count: number; index: number }) {
  return (
    <Stack
      direction="row"
      gap="2xs"
      align="center"
      aria-label={`Step ${index + 1} of ${count}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            "block size-1.5 rounded-full",
            i === index ? "bg-primary" : "bg-muted-foreground/30",
          )}
        />
      ))}
    </Stack>
  );
}
