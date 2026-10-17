import type { ReactNode } from "react";
import { modelMeta } from "@plugins/conversations/plugins/model-provider/core";
import { familyClass } from "@plugins/conversations/plugins/model-provider/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { InlineText } from "@plugins/primitives/plugins/inline-text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { ClaudeCliCall } from "../../core";
import {
  formatCallDuration,
  SLOW_CALL_MS,
} from "../internal/format-call-duration";

/**
 * One recorded `claude --print` call, rendered in full: a header (source,
 * model, outcome), the meta grid (when, how long, which model, the call and
 * correlation ids), the source context — whose ids (`task-…`, `conv-…`) render
 * as the registered id chips — then the output OR the error, the prompt and the
 * system prompt, each with its size and a copy button.
 *
 * This lives with the plugin that OWNS the record so every consumer showing "what
 * was the model asked, and what did it say" renders it identically — the Debug
 * pane's detail and an event run's Model call section both compose this rather
 * than owning it. Callers supply their own surrounding chrome (pane, card,
 * inset); this is the block, not the container.
 */
export function ClaudeCliCallDetail({ call }: { call: ClaudeCliCall }) {
  const meta = modelMeta(call.model);
  const isError = call.error !== null;
  const isSlow = call.durationMs > SLOW_CALL_MS;
  const context = Object.entries(call.sourceContext ?? {});
  return (
    <Stack gap="lg">
      <Cluster>
        <Text variant="code" tone="strong">
          {call.sourceName}
        </Text>
        <Badge colorClass={familyClass(meta.family)}>{meta.label}</Badge>
        {isError ? (
          <Badge
            variant="destructive"
            icon={<StatusDot colorClass="bg-destructive" />}
          >
            Failed
          </Badge>
        ) : (
          <Badge variant="success" icon={<StatusDot colorClass="bg-success" />}>
            Succeeded
          </Badge>
        )}
      </Cluster>

      <Surface level="base" className={WELL_CLASS}>
        <Inset pad="md">
          <Grid minCellWidth="8rem" gap="md">
            <MetaCell
              label="Started"
              note={<RelativeTime date={call.createdAt} />}
            >
              <Text
                className="tabular-nums"
                title={call.createdAt.toLocaleString()}
              >
                {call.createdAt.toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </Text>
            </MetaCell>
            <MetaCell
              label="Duration"
              note={isSlow ? `over ${formatCallDuration(SLOW_CALL_MS)}` : null}
            >
              {/* A slow call reads in the warning tint, as in the log's column. */}
              <Text
                className={
                  isSlow ? "tabular-nums text-warning" : "tabular-nums"
                }
              >
                {formatCallDuration(call.durationMs)}
              </Text>
            </MetaCell>
            <MetaCell label="Model id">
              <Text variant="code">{call.model}</Text>
            </MetaCell>
            <MetaCell label="Call id">
              <IdValue value={call.id} />
            </MetaCell>
            {call.correlationId !== null && (
              <MetaCell label="Correlation">
                <IdValue value={call.correlationId} />
              </MetaCell>
            )}
          </Grid>
        </Inset>
      </Surface>

      {context.length > 0 && (
        <Stack gap="xs">
          <SectionHeader
            label="Context"
            count={`${context.length} ${context.length === 1 ? "key" : "keys"}`}
          />
          <Surface level="base" className={WELL_CLASS}>
            <Inset pad="sm">
              <Stack gap="sm">
                {context.map(([key, value]) => (
                  <Line key={key} className="gap-md">
                    <Text
                      variant="code"
                      tone="muted"
                      className={cn("w-32", rigidClass())}
                    >
                      {key}
                    </Text>
                    <Fill>
                      <ContextValue value={value} />
                    </Fill>
                  </Line>
                ))}
              </Stack>
            </Inset>
          </Surface>
        </Stack>
      )}

      {isError ? (
        <TextBlock
          label="Error"
          text={call.error ?? ""}
          tone="destructive"
          size="short"
        />
      ) : (
        <TextBlock label="Output" text={call.output ?? ""} size="short" />
      )}
      <TextBlock label="Prompt" text={call.prompt} size="long" />
      {call.system && (
        <TextBlock label="System" text={call.system} size="short" />
      )}
    </Stack>
  );
}

/**
 * The hairline-bordered box the meta grid and the context rows sit in — on the
 * pane's own canvas, so the muted tags and id chips inside keep their contrast,
 * while the text blocks below take the tinted code well.
 */
const WELL_CLASS = "rounded-md border border-border";

/**
 * One source-context value: a string through `InlineText` (so a `task-…` /
 * `conv-…` id renders as its id chip), a list of scalars as one tag per item,
 * anything else as its JSON.
 */
function ContextValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <Text variant="code">
        <InlineText text={value} />
      </Text>
    );
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    return (
      <Cluster gap="2xs">
        {value.map((item, i) => (
          // Index in the key: a context list may repeat a value.
          <Badge key={`${String(item)}#${String(i)}`} mono>
            {String(item)}
          </Badge>
        ))}
      </Cluster>
    );
  }
  return <Text variant="code">{JSON.stringify(value)}</Text>;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * One cell of the meta grid: a caption label, the value on ONE line (a long id
 * ellipsizes rather than breaking mid-token), and an optional muted note under
 * it.
 */
function MetaCell({
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

/**
 * An id in a meta cell: ellipsized to the cell (the full value on hover) with
 * its copy button kept whole beside it. A fragment, not its own line — it sits
 * in the cell's line, so the cell's width is what bounds it.
 */
function IdValue({ value }: { value: string }) {
  return (
    <>
      <Text variant="code" title={value}>
        {value}
      </Text>
      <CopyButton text={value} tooltip="Copy" aspect="inline" />
    </>
  );
}

function SectionHeader({
  label,
  count,
  copy,
}: {
  label: string;
  count: string;
  copy?: string;
}) {
  return (
    <Line className="gap-sm">
      <Text variant="label">{label}</Text>
      <Text variant="caption" tone="muted" className="tabular-nums">
        {count}
      </Text>
      <Fill />
      {copy !== undefined && (
        <CopyButton text={copy} tooltip={`Copy ${label.toLowerCase()}`} />
      )}
    </Line>
  );
}

/**
 * How tall a text block may grow before it scrolls: a `short` one (output,
 * error, system) is usually a few lines, so it stays compact and leaves the
 * prompt — the long one — room above the fold.
 */
const BLOCK_MAX_HEIGHT = { short: "max-h-48", long: "max-h-80" } as const;

/** A labelled body of model text (output, error, prompt, system): its size, a copy button, and a bounded scroll. */
function TextBlock({
  label,
  text,
  tone,
  size,
}: {
  label: string;
  text: string;
  tone?: "destructive";
  size: keyof typeof BLOCK_MAX_HEIGHT;
}) {
  return (
    <Stack gap="xs">
      <SectionHeader
        label={label}
        count={`${text.length.toLocaleString()} chars`}
        copy={text}
      />
      <Scroll
        as="pre"
        className={cn(
          "whitespace-pre-wrap break-words rounded-md border px-md py-sm text-code",
          BLOCK_MAX_HEIGHT[size],
          tone === "destructive"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-border bg-muted",
        )}
      >
        {text === "" ? <Text tone="muted">&lt;empty&gt;</Text> : text}
      </Scroll>
    </Stack>
  );
}
