import { useState, type ReactNode } from "react";
import type { ContextReading, ContextUsage } from "@plugins/conversations/core";
import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { sendConversationTurn } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { FoldMotion } from "@plugins/primitives/plugins/collapsible/web";
import {
  Button,
  Textarea,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { contextRows, tokensToAutoCompact } from "./context-math";

const chevronIcon = symbol("chevron-right");
const compactIcon = symbol("compress");

// The note under the bar appears only once auto-compact is this close (a
// share of the threshold): further away it is a number nobody needs.
const AUTO_COMPACT_NOTE_SHARE = 0.15;

// Setup rows take the categorical series in order; Messages wears the
// primary colour, since it is the part a compaction shrinks.
const MESSAGES_COLOR = "var(--primary)";
const seriesColor = (i: number) => `var(--categorical-${(i % 10) + 1})`;

// The harness's names for the rows that carry a per-item breakdown.
const MEMORY_FILES_ROW = "Memory files";
const MCP_TOOLS_ROW = "MCP tools";

/**
 * The context window, as the harness measures it — the used share against the
 * window, what fills it (the conversation itself, and the setup it starts
 * with: system prompt, tools, memory files, skills, MCP), where auto-compact
 * kicks in — and the Compact action, which sends `/compact` with the
 * instructions typed here as an ordinary turn.
 */
export function ContextCard({
  conversationId,
  reading,
  onCompacted,
}: {
  conversationId: string;
  reading: ContextReading;
  onCompacted: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  const compact = () => {
    const focus = instructions.trim();
    sendConversationTurn(conversationId, {
      text: focus ? `/compact ${focus}` : "/compact",
    });
    setInstructions("");
    onCompacted();
  };
  return (
    <Stack gap="md">
      {reading.kind === "ready" ? (
        <Breakdown usage={reading.usage} />
      ) : (
        <Text variant="caption" tone="muted">
          {reading.reason === "not-running"
            ? "The context is measured while the agent is running."
            : "This agent started before context readings existed; it reports them from its next start."}
        </Text>
      )}
      <Stack gap="sm">
        <Textarea
          rows={2}
          placeholder="Compaction instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              compact();
            }
          }}
        />
        <Stack direction="row" justify="end" gap="none">
          <Button onClick={compact}>
            <Icon icon={compactIcon} />
            Compact
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}

function Breakdown({ usage }: { usage: ContextUsage }) {
  const { messages, setup, free, reserve } = contextRows(usage);
  const window = usage.rawMaxTokens;
  const share = (tokens: number) => `${(tokens / window) * 100}%`;
  const percent = Math.round((usage.totalTokens / window) * 100);
  const toAutoCompact = tokensToAutoCompact(usage);
  const showAutoCompact =
    toAutoCompact !== null &&
    toAutoCompact < (usage.autoCompactThreshold ?? 0) * AUTO_COMPACT_NOTE_SHARE;
  const setupTotal = setup.reduce((sum, c) => sum + c.tokens, 0);

  return (
    <Stack gap="sm">
      <Stack direction="row" align="baseline" justify="between" gap="sm">
        <Stack direction="row" align="baseline" gap="xs">
          <Text variant="heading" className="tabular-nums">
            {percent}%
          </Text>
          <Text variant="caption" tone="muted">
            used
          </Text>
        </Stack>
        <Text variant="caption" tone="muted" className="tabular-nums">
          <Text tone="strong">{formatTokenCount(usage.totalTokens)}</Text> /{" "}
          {formatTokenCount(window)}
        </Text>
      </Stack>

      <Stack gap="xs">
        <Clip className="h-1.5 rounded-full bg-muted">
          <Stack direction="row" gap="none" className="h-full">
            {setup.map((c, i) => (
              <span
                key={c.name}
                title={`${c.name} · ${formatTokenCount(c.tokens)}`}
                style={{ width: share(c.tokens), background: seriesColor(i) }}
              />
            ))}
            {messages && (
              <span
                title={`${messages.name} · ${formatTokenCount(messages.tokens)}`}
                style={{
                  width: share(messages.tokens),
                  background: MESSAGES_COLOR,
                }}
              />
            )}
            {/* Free space, then the reserve flush right, as the window ends. */}
            <span className={growClass()} />
            {reserve > 0 && (
              <span
                title={`Reserved for compacting · ${formatTokenCount(reserve)}`}
                className="opacity-40"
                style={{
                  width: share(reserve),
                  backgroundImage:
                    "repeating-linear-gradient(-45deg, transparent 0 3px, var(--muted-foreground) 3px 4.5px)",
                }}
              />
            )}
          </Stack>
        </Clip>
        {showAutoCompact && (
          <Stack direction="row" justify="end" gap="none">
            <Text variant="caption" className="text-warning tabular-nums">
              Auto-compacts in {formatTokenCount(toAutoCompact)}
            </Text>
          </Stack>
        )}
      </Stack>

      <Stack gap="2xs">
        {messages && (
          <Share
            color={MESSAGES_COLOR}
            name={messages.name}
            tokens={messages.tokens}
            detail={messageDetail(usage)}
          />
        )}
        <Share name="Setup" tokens={setupTotal} defaultOpen>
          {setup.map((c, i) => (
            <Share
              key={c.name}
              color={seriesColor(i)}
              name={c.name}
              tokens={c.tokens}
              detail={setupDetail(usage, c.name)}
              nested
            />
          ))}
        </Share>
        <Share name="Free" tokens={free} />
      </Stack>
    </Stack>
  );
}

interface Item {
  name: string;
  tokens: number;
}

function messageDetail(usage: ContextUsage): Item[] {
  const b = usage.messageBreakdown;
  if (!b) return [];
  return [
    { name: "Tool results", tokens: b.toolResultTokens },
    { name: "Tool calls", tokens: b.toolCallTokens },
    { name: "Agent replies", tokens: b.assistantMessageTokens },
    { name: "Your messages", tokens: b.userMessageTokens },
    { name: "Attachments", tokens: b.attachmentTokens },
  ].filter((i) => i.tokens > 0);
}

function setupDetail(usage: ContextUsage, row: string): Item[] {
  if (row === MEMORY_FILES_ROW)
    return usage.memoryFiles.map((f) => ({ name: f.path, tokens: f.tokens }));
  if (row === MCP_TOOLS_ROW) {
    const byServer = new Map<string, number>();
    for (const tool of usage.mcpTools) {
      if (tool.isLoaded === false) continue;
      byServer.set(
        tool.serverName,
        (byServer.get(tool.serverName) ?? 0) + tool.tokens,
      );
    }
    return [...byServer].map(([name, tokens]) => ({ name, tokens }));
  }
  return [];
}

/**
 * One share of the window: its colour key, name and size; a share with a
 * breakdown (`detail` items, or nested shares as `children`) discloses it.
 */
function Share({
  color,
  name,
  tokens,
  detail = [],
  children,
  defaultOpen = false,
  nested = false,
}: {
  color?: string;
  name: string;
  tokens: number;
  detail?: Item[];
  children?: ReactNode;
  defaultOpen?: boolean;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const discloses = detail.length > 0 || children !== undefined;
  const label = (
    <Line className="w-full gap-sm">
      <span
        className={cn("size-2 rounded-xs", rigidClass())}
        style={{ background: color ?? "transparent" }}
      />
      <Text
        variant="caption"
        tone={nested ? "muted" : "default"}
        className={cn(growClass(), yieldClass("x"), "text-left")}
      >
        {name}
      </Text>
      <Text variant="caption" tone="muted" className="tabular-nums">
        {formatTokenCount(tokens)}
      </Text>
      <span className={cn("size-3", rigidClass())}>
        {discloses && (
          <Icon
            icon={chevronIcon}
            className={cn("size-3 transition-transform", open && "rotate-90")}
          />
        )}
      </span>
    </Line>
  );
  return (
    <Stack gap="2xs">
      {discloses ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="w-full rounded-xs hover:bg-muted/50"
        >
          {label}
        </button>
      ) : (
        label
      )}
      {discloses && (
        <FoldMotion open={open}>
          <Inset l="md">
            <Stack gap="2xs">
              {children}
              {detail.map((item) => (
                <Line key={item.name} className="gap-sm">
                  <Text
                    variant="caption"
                    tone="faint"
                    side="start"
                    className={cn(growClass(), yieldClass("x"))}
                    title={item.name}
                  >
                    {item.name}
                  </Text>
                  <Text variant="caption" tone="faint" className="tabular-nums">
                    {formatTokenCount(item.tokens)}
                  </Text>
                  <span className={cn("size-3", rigidClass())} />
                </Line>
              ))}
            </Stack>
          </Inset>
        </FoldMotion>
      )}
    </Stack>
  );
}
