import type { ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { formatAbsolute, formatWhen } from "../internal/format";

// The detail panes' shared vocabulary, after the Claude CLI call detail
// (`infra/claude-cli`'s ClaudeCliCallDetail): a header of name + badges, a row
// of actions, a bordered meta grid, then labelled code blocks with copy.

const infoIcon = symbol("info");

/** The hairline-bordered well the meta grid sits in, on the pane's own canvas. */
const WELL_CLASS = "rounded-md border border-border";

/** The detail's head: the entity's name (mono), its badges, then its buttons. */
export function DetailHeader({
  name,
  badges,
  buttons,
}: {
  name: string;
  badges: ReactNode;
  buttons?: ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Text as="div" variant="code" tone="strong" title={name}>
        {name}
      </Text>
      <Cluster gap="xs">{badges}</Cluster>
      {buttons !== undefined && <Cluster gap="sm">{buttons}</Cluster>}
    </Stack>
  );
}

/** The bordered grid of meta cells. */
export function MetaGrid({ children }: { children: ReactNode }) {
  return (
    <Surface level="base" className={WELL_CLASS}>
      <Inset pad="md">
        <Grid minCellWidth="10rem" gap="md">
          {children}
        </Grid>
      </Inset>
    </Surface>
  );
}

/**
 * One cell of the meta grid: a caption label, the value on ONE line (a long id
 * ellipsizes rather than breaking mid-token), and an optional muted note under
 * it.
 */
export function MetaCell({
  label,
  note,
  children,
}: {
  label: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap="2xs" className={yieldClass("x")}>
      <Text as="div" variant="caption" tone="muted">
        {label}
      </Text>
      <Line className="gap-2xs">{children}</Line>
      {note !== undefined && note !== null && (
        <Text as="div" variant="caption" tone="muted">
          {note}
        </Text>
      )}
    </Stack>
  );
}

/** An id in a meta cell: ellipsized to the cell (full value on hover), with its copy button. */
export function IdValue({ value }: { value: string }) {
  return (
    <>
      <Text variant="code" title={value}>
        {value}
      </Text>
      <CopyButton text={value} tooltip="Copy" aspect="inline" />
    </>
  );
}

/** An instant in a meta cell: the absolute time, with how long ago (or until) as the note. */
export function TimeCell({ label, date }: { label: string; date: Date }) {
  const now = useNow(10_000);
  return (
    <MetaCell label={label} note={formatWhen(date, now)}>
      <Text className="tabular-nums" title={date.toISOString()}>
        {formatAbsolute(date)}
      </Text>
    </MetaCell>
  );
}

/** A section's heading line: its label, an optional muted count, and an optional copy. */
export function SectionHeader({
  label,
  count,
  copy,
}: {
  label: string;
  count?: string;
  copy?: string;
}) {
  return (
    <Line className="gap-sm">
      <Text variant="label">{label}</Text>
      {count !== undefined && (
        <Text variant="caption" tone="muted" className="tabular-nums">
          {count}
        </Text>
      )}
      <Fill />
      {copy !== undefined && (
        <CopyButton text={copy} tooltip={`Copy ${label.toLowerCase()}`} />
      )}
    </Line>
  );
}

/** A labelled section of the detail: its header line, then its body. */
export function DetailSection({
  label,
  count,
  copy,
  children,
}: {
  label: string;
  count?: string;
  copy?: string;
  children: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <SectionHeader label={label} count={count} copy={copy} />
      {children}
    </Stack>
  );
}

/** A labelled block of text (an error, a stack): copyable, bounded, scrolling. */
export function CodeBlock({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone?: "destructive";
}) {
  return (
    <DetailSection
      label={label}
      count={`${text.length.toLocaleString()} chars`}
      copy={text}
    >
      <Scroll
        as="pre"
        className={cn(
          "max-h-64 whitespace-pre-wrap break-words rounded-md border px-md py-sm text-code",
          tone === "destructive"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-border bg-muted",
        )}
      >
        {text === "" ? <Text tone="muted">&lt;empty&gt;</Text> : text}
      </Scroll>
    </DetailSection>
  );
}

/** A labelled JSON value, pretty-printed, with copy. */
export function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = JSON.stringify(value ?? null, null, 2);
  return (
    <DetailSection label={label} copy={text}>
      <Scroll
        as="pre"
        axis="both"
        className="max-h-80 rounded-md border border-border bg-muted px-md py-sm text-code"
      >
        {text}
      </Scroll>
    </DetailSection>
  );
}

/** An explanatory note in a muted well (worker liveness, a dangling trigger). */
export function Note({
  tone,
  children,
}: {
  tone?: "destructive";
  children: ReactNode;
}) {
  return (
    <Surface
      level="sunken"
      className={cn(
        "rounded-md",
        tone === "destructive" && "border border-destructive/30",
      )}
    >
      <Inset pad="sm">
        <Line className="gap-sm">
          <Icon
            icon={infoIcon}
            className={cn(
              "size-4",
              tone === "destructive"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          />
          <Fill>
            <Stack gap="2xs">{children}</Stack>
          </Fill>
        </Line>
      </Inset>
    </Surface>
  );
}
