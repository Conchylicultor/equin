import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  ShellStateChip,
  shellOutputPane,
  useConversationShells,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const terminalIcon = symbol("terminal");

interface BashInput {
  command: string;
  description?: string;
  run_in_background?: boolean;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

export function BashToolView({ event }: ToolRendererProps) {
  const input = event.input as BashInput;
  // Only a backgrounded call reads the conversation's shells — a plain one
  // has nothing to join, and folds nothing.
  if (input.run_in_background === true) {
    return <BackgroundBashToolView event={event} input={input} />;
  }
  return (
    <ToolCallCard
      event={event}
      summary={input.description || `$ ${input.command}`}
    >
      <BashBody event={event} input={input} />
    </ToolCallCard>
  );
}

/**
 * A `Bash` call with `run_in_background`. Its `tool_result` is the launch
 * acknowledgement, not the end — so "is it running" is the shell's own state
 * (`useConversationShells`, joined by this call's tool-use id), never the
 * result's presence. The live output is in the shell's pane, not inline.
 */
function BackgroundBashToolView({
  event,
  input,
}: {
  event: ToolRendererProps["event"];
  input: BashInput;
}) {
  const conversationId = useJsonlConversationId();
  const shells = useConversationShells(conversationId);
  const openPane = useOpenPane();
  // Absent from a known set: no result yet (the card's own derivation says
  // running), or a failed launch whose result is not an acknowledgement — the
  // plain card, which is what it is.
  const shell =
    shells.kind === "known"
      ? shells.shells.find((s) => s.toolUseId === event.toolUseId)
      : undefined;

  return (
    <Stack gap="2xs">
      <ToolCallCard
        event={event}
        summary={input.description || `$ ${input.command}`}
        leading={
          <Badge variant="muted" className="tracking-wider">
            Background
          </Badge>
        }
        running={
          shell === undefined ? undefined : shell.state.kind === "running"
        }
        note={shell && <ShellStateChip shell={shell} />}
        aside={
          shell && (
            <IconButton
              icon={terminalIcon}
              label="Open output"
              // Isolated: the card header it sits in toggles on click.
              {...activationProps(
                openPane.to(
                  shellOutputPane,
                  { shellId: shell.shellId },
                  { mode: "push" },
                ),
                { isolate: true },
              )}
            />
          )
        }
      >
        <BashBody event={event} input={input} />
      </ToolCallCard>
      {shells.kind === "failed" && (
        <div className="px-md">
          <ResourceErrorInline
            variant="inline"
            subject="the background shell's state"
            error={shells.error}
            refetch={shells.refetch}
          />
        </div>
      )}
    </Stack>
  );
}

/** The command, and its result: the output, or a background call's acknowledgement. */
function BashBody({
  event,
  input,
}: {
  event: ToolRendererProps["event"];
  input: BashInput;
}) {
  const result = event.result;
  const output = result?.content ? stripAnsi(result.content) : null;
  return (
    <ContentScope>
      <Clip
        // eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets this output block from the ToolCallCard header
        className="mt-2 rounded-md border border-border/40 bg-muted font-mono"
      >
        <Text as="div" variant="caption">
          <Stack direction="row" gap="sm" align="start" className="px-md py-sm">
            <span className="select-none text-muted-foreground/40">$</span>
            <Fill
              as="span"
              className="whitespace-pre-wrap break-words text-foreground"
            >
              {input.command}
            </Fill>
          </Stack>
          {result && (
            <>
              <div className="border-t border-border/30" />
              <Scroll
                as="pre"
                className={`max-h-72 whitespace-pre-wrap break-words px-md py-sm ${
                  result.isError ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {output ?? (
                  <span className="italic opacity-50">(no output)</span>
                )}
              </Scroll>
            </>
          )}
        </Text>
      </Clip>
    </ContentScope>
  );
}
