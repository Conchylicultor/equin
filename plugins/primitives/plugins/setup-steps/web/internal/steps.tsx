import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

const checkIcon = symbol("check");

/**
 * Lifecycle position of a step within a guided setup flow. `upcoming` steps are
 * dimmed and inert — pointer- and Tab-unreachable, so no control inside one
 * needs its own `disabled` — `active` is the step the user should act on, `done`
 * shows a green check instead of the number.
 */
export type StepState = "upcoming" | "active" | "done";

export interface StepProps {
  title: string;
  state: StepState;
  children?: ReactNode;
}

/** Injected by `<Steps>` — never passed by consumers. */
interface StepPositionProps {
  number?: number;
  isLast?: boolean;
}

/**
 * Ordered container for `<Step>` items. Renders an `<ol>` and injects each
 * step's number and last-position automatically, so callers never maintain
 * `number={…}` by hand. Direct children must be `<Step>` elements.
 */
export function Steps({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <Stack as="ol" gap="none" className={className}>
      {items.map((el, i) =>
        cloneElement(el as ReactElement<StepPositionProps>, {
          key: el.key ?? i,
          number: i + 1,
          isLast: i === items.length - 1,
        }),
      )}
    </Stack>
  );
}

/**
 * One numbered step: a state-tinted circle (number → check when done) with a
 * vertical rail connecting it to the next step, a title, and arbitrary body
 * content. `upcoming` dims the whole step and marks it inert — pointer- AND
 * Tab-unreachable — so a step's controls need no individual `disabled` wiring.
 */
export function Step({
  title,
  state,
  children,
  number = 1,
  isLast = true,
}: StepProps & StepPositionProps) {
  const done = state === "done";
  return (
    <Stack
      as="li"
      direction="row"
      gap="md"
      inert={state === "upcoming"}
      className={cn(state === "upcoming" && "opacity-40")}
    >
      {/* Default cross-axis stretch keeps this column at full row height, so
          the rail (the Fill below the circle) spans down to the next step. */}
      <Stack direction="col" align="center" gap="none">
        <Center
          className={cn(
            "size-6 rounded-full",
            done
              ? "bg-success/15 text-success"
              : state === "active"
                ? "bg-primary/10 text-primary-text"
                : "bg-muted text-muted-foreground",
          )}
        >
          {done ? (
            <Icon icon={checkIcon} className="size-3.5" />
          ) : (
            <Text as="span" variant="caption" className="font-medium">
              {number}
            </Text>
          )}
        </Center>
        {!isLast && <Fill axis="y" aria-hidden className="w-px bg-border" />}
      </Stack>
      <Fill>
        <Stack
          gap="xs"
          className={!isLast ? insetClass({ b: "lg" }) : undefined}
        >
          <Text as="span" variant="label">
            {title}
          </Text>
          {children}
        </Stack>
      </Fill>
    </Stack>
  );
}

/** External-link affordance for a step: opens `href` in a new tab. */
export function StepLink({
  href,
  label = "Open",
}: {
  href: string;
  label?: string;
}) {
  return (
    <NewTabButton href={href} variant="outline" className="w-fit">
      {label}
    </NewTabButton>
  );
}

/** Muted explanatory line inside a step body ("Application type: Desktop app"). */
export function StepNote({ children }: { children: ReactNode }) {
  return (
    <Text as="p" variant="caption" className="text-muted-foreground">
      {children}
    </Text>
  );
}

/** Copyable command or URL line: a code block plus a copy button. */
export function StepCommand({ text, title }: { text: string; title: string }) {
  return (
    <Stack direction="row" align="start" gap="sm">
      <Fill>
        <Text
          as="code"
          variant="caption"
          className="rounded-md bg-muted px-sm py-xs break-all"
        >
          {text}
        </Text>
      </Fill>
      <CopyButton text={text} tooltip={title} />
    </Stack>
  );
}

/** Inline success line for a completed step ("Connected", "Key generated", …). */
export function StepDone({ children }: { children: ReactNode }) {
  return (
    <Text as="div" variant="caption" className="text-success">
      <Stack direction="row" align="center" gap="xs">
        <Icon icon={checkIcon} className="size-4" />
        {children}
      </Stack>
    </Text>
  );
}

interface StepListItemInjected {
  number?: number;
}

/**
 * The click-path inside a step: a short numbered list of actions to perform
 * ("Click Create map ID", "Set Map type to JavaScript"). Body-size and
 * full-contrast — unlike {@link StepNote}, whose muted caption is for
 * asides — so the instructions that must be followed cannot be skimmed past.
 * Direct children must be {@link StepAction} elements; numbers are injected.
 */
export function StepActions({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <Stack as="ol" gap="xs">
      {items.map((el, i) =>
        cloneElement(el as ReactElement<StepListItemInjected>, {
          key: el.key ?? i,
          number: i + 1,
        }),
      )}
    </Stack>
  );
}

/**
 * One action of a {@link StepActions} list. Wrap the exact UI label in
 * {@link StepKey}. `detail` is a block the action needs right under it (the
 * {@link StepCommand} to copy, a field) — so the list stays one numbered
 * click-path instead of being split, and renumbered, around it.
 */
export function StepAction({
  children,
  detail,
  number = 1,
}: { children: ReactNode; detail?: ReactNode } & StepListItemInjected) {
  return (
    <Stack as="li" direction="row" align="baseline" gap="sm">
      <Text as="span" variant="caption" tone="muted">
        {number}.
      </Text>
      <Fill>
        <Stack gap="xs">
          <Text as="span">{children}</Text>
          {detail}
        </Stack>
      </Fill>
    </Stack>
  );
}

/**
 * The exact label or value to pick in the other app's UI ("JavaScript",
 * "Vector"): emphasised inline, so the critical choices stand out of a
 * sentence.
 */
export function StepKey({ children }: { children: ReactNode }) {
  return (
    <Text as="strong" className="font-semibold">
      {children}
    </Text>
  );
}
