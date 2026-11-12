import { z } from "zod";
import { useHomeDisplay } from "@plugins/infra/plugins/host-account/web";
import type {
  ToolCall,
  ToolViewProps,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolCode,
  ToolOutput,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useJsonlConversationId } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  ShellStateChip,
  shellOutputPane,
  useConversationShells,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/web";
import type { DeliveredShell } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/background-shells/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const terminalIcon = symbol("terminal");

/** `Bash`'s input, as its card draws it. */
export const BashInputSchema = z.looseObject({
  command: z.string(),
  description: z.string().optional(),
  run_in_background: z.boolean().optional(),
});
type BashInput = z.infer<typeof BashInputSchema>;

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

export function BashToolView({ event, input }: ToolViewProps<BashInput>) {
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
 *
 * In a sub-agent's transcript (rendered under its parent conversation's id)
 * the call is a shell the conversation did not launch: it joins the
 * conversation's DELIVERED shells — the sub-agent's shells whose end reached
 * the parent — and starts at this call's own time, which is its launch.
 * A sub-agent's shell still running has no end delivered yet: the plain card.
 */
function BackgroundBashToolView({
  event,
  input,
}: {
  event: ToolCall;
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
      ? (shells.shells.find((s) => s.toolUseId === event.toolUseId) ??
        deliveredShellOf(shells.delivered, event))
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

/** The delivered shell this sub-agent call launched, with its start read off the call. */
function deliveredShellOf(
  delivered: readonly DeliveredShell[],
  event: ToolCall,
): (DeliveredShell & { startedAt: Date }) | undefined {
  const shell = delivered.find((s) => s.toolUseId === event.toolUseId);
  return shell === undefined
    ? undefined
    : { ...shell, startedAt: new Date(event.at) };
}

/**
 * A failed Bash result opens with the harness's `Exit code N` line; a result
 * not flagged as an error is a command that exited 0. Anything else (a
 * timeout, a denial, an interrupted call) has no exit code to show.
 */
const EXIT_LINE = /^Exit code (\d+)\n?/;

function readExit(result: NonNullable<ToolCall["result"]>): {
  code: number | undefined;
  output: string;
} {
  const text = stripAnsi(result.content);
  if (result.outcomeUnknown) return { code: undefined, output: text };
  if (!result.isError) return { code: 0, output: text };
  const m = EXIT_LINE.exec(text);
  return m
    ? { code: Number(m[1]), output: text.slice(m[0].length) }
    : { code: undefined, output: text };
}

/** The command, and its result: the output, or a background call's acknowledgement. */
function BashBody({ event, input }: { event: ToolCall; input: BashInput }) {
  const homeDisplay = useHomeDisplay();
  const result = event.result;
  // A backgrounded call's result is its launch acknowledgement, not the
  // command's end: it has no exit code to read.
  const exit =
    result &&
    (input.run_in_background === true
      ? { code: undefined, output: stripAnsi(result.content) }
      : readExit(result));
  return (
    <>
      <ToolSection label="Input" copyText={input.command}>
        <ToolCode>
          <Text tone="faint" className="select-none">
            ${" "}
          </Text>
          {homeDisplay(input.command)}
        </ToolCode>
      </ToolSection>
      {exit && (
        <ToolOutput
          event={event}
          text={homeDisplay(exit.output)}
          detail={exit.code !== undefined ? `exit ${exit.code}` : undefined}
          empty="(no output)"
        />
      )}
    </>
  );
}
