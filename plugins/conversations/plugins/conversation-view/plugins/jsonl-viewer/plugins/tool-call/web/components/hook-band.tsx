import type {
  HookOutcome,
  HookRecord,
} from "@plugins/conversations/plugins/transcript-source/core";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { hookSummary, isLoudHook } from "../../core";

const shieldIcon = symbol("shield");

/** Tone and title per loud outcome. A block is the outcome that changed the
 *  call; an error or a cancel is the hook's own trouble (the call is fine);
 *  context and a message are the hook talking to the agent. */
const LOUD: Record<
  Exclude<HookOutcome, "pass">,
  { title: string; tone: string }
> = {
  block: { title: "Blocked", tone: "bg-destructive/10 text-destructive" },
  error: { title: "Hook failed", tone: "bg-warning/10 text-warning" },
  cancelled: { title: "Hook cancelled", tone: "bg-warning/10 text-warning" },
  context: { title: "Added context", tone: "bg-info/10 text-info" },
  message: { title: "Hook message", tone: "bg-info/10 text-info" },
};

const hookKey = (h: HookRecord) => `${h.at}|${h.name}|${h.outcome}`;

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

function titleOf(h: HookRecord): string {
  if (h.outcome === "pass") return "Passed";
  // A PreToolUse block is the one that means the call never ran.
  if (h.outcome === "block" && h.event === "PreToolUse")
    return "Blocked before running";
  return LOUD[h.outcome].title;
}

/** What the hook ran and said, beyond its one-line summary. */
function HookDetails({ hook }: { hook: HookRecord }) {
  const meta = [
    hook.command && `$ ${hook.command}`,
    hook.exitCode !== undefined && `exit ${hook.exitCode}`,
    hook.durationMs !== undefined && formatMs(hook.durationMs),
  ].filter(Boolean);
  const body = [hook.text, hook.stderr, hook.stdout]
    .map((s) => s?.trim())
    .filter(Boolean);
  if (meta.length === 0 && body.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-caption text-muted-foreground hover:text-foreground">
        <Stack as="span" direction="row" gap="xs" align="center">
          <CollapsibleChevron className="size-3" />
          Details
        </Stack>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="xs" className="font-mono text-muted-foreground">
          {meta.length > 0 && (
            <Text as="p" variant="caption" className="break-all">
              {meta.join("   ")}
            </Text>
          )}
          {body.map((b) => (
            <Text
              key={b}
              as="p"
              variant="caption"
              className="whitespace-pre-wrap break-words"
            >
              {b}
            </Text>
          ))}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One loud hook as a tinted entry: what happened, which hook, its one-line
 * summary, and the rest behind Details.
 */
function HookEntry({ hook }: { hook: HookRecord }) {
  if (hook.outcome === "pass")
    throw new Error("HookEntry draws loud hooks only; a pass is counted");
  const summary = hookSummary(hook);
  return (
    <Stack
      gap="xs"
      className={cn("rounded-md px-sm py-xs", LOUD[hook.outcome].tone)}
    >
      <Stack as="span" direction="row" gap="xs" align="center">
        <Icon icon={shieldIcon} className="size-3.5" />
        <Text variant="caption" className="font-medium">
          {titleOf(hook)}
        </Text>
        <Text variant="caption" tone="muted">
          · {hook.name}
        </Text>
      </Stack>
      {summary && (
        <Text
          as="p"
          variant="caption"
          className="whitespace-pre-wrap break-words text-foreground"
        >
          {summary}
        </Text>
      )}
      <HookDetails hook={hook} />
    </Stack>
  );
}

/** Every loud hook of a call, in transcript order — or nothing. The top of
 *  the card's body: seen once the reader opens the card. */
export function HookBand({
  hooks,
}: {
  hooks: readonly HookRecord[] | undefined;
}) {
  const loud = hooks?.filter(isLoudHook) ?? [];
  if (loud.length === 0) return null;
  return (
    <Stack gap="xs">
      {loud.map((h) => (
        <HookEntry key={hookKey(h)} hook={h} />
      ))}
    </Stack>
  );
}

/** Worst first: what the header's shield takes its colour from. */
const SEVERITY: readonly HookOutcome[] = [
  "block",
  "error",
  "cancelled",
  "context",
  "message",
  "pass",
];
const SHIELD_TONE: Record<HookOutcome, string> = {
  block: "text-destructive",
  error: "text-warning",
  cancelled: "text-warning",
  context: "text-info",
  message: "text-info",
  pass: "text-muted-foreground/70",
};
const OUTCOME_WORD: Record<HookOutcome, string> = {
  block: "blocked",
  error: "failed",
  cancelled: "cancelled",
  context: "added context",
  message: "said something",
  pass: "passed",
};

/**
 * The closed card's sign that hooks ran on the call: a shield in the colour of
 * the worst outcome (red when one blocked it), with a count when there are
 * several; hover lists them. What they said is in the card's body.
 */
export function HookIndicator({
  hooks,
}: {
  hooks: readonly HookRecord[] | undefined;
}) {
  if (!hooks?.length) return null;
  const worst =
    SEVERITY.find((o) => hooks.some((h) => h.outcome === o)) ?? "pass";
  const list = (
    <Stack gap="2xs">
      {hooks.map((h) => (
        <Text key={hookKey(h)} variant="caption">
          {h.name} {OUTCOME_WORD[h.outcome]}
          {h.durationMs !== undefined ? ` · ${formatMs(h.durationMs)}` : ""}
        </Text>
      ))}
    </Stack>
  );
  return (
    <WithTooltip content={list}>
      <Stack
        as="span"
        direction="row"
        gap="2xs"
        align="center"
        className={cn("tabular-nums", SHIELD_TONE[worst])}
        aria-label={`${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"}, ${OUTCOME_WORD[worst]}`}
      >
        <Icon icon={shieldIcon} className="size-3.5" />
        {hooks.length > 1 && hooks.length}
      </Stack>
    </WithTooltip>
  );
}
