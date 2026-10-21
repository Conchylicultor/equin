import type { ReactNode } from "react";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  JumpToBottomButton,
  useStickyScroll,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  terminalText,
  type BackgroundShell,
  type ShellOutput,
} from "../../core";
import {
  useConversationShells,
  useShellOutput,
} from "../internal/use-conversation-shells";
import { shellOutputPane } from "../panes";
import { ShellStateChip } from "./shell-state-chip";

const MONO = "font-mono whitespace-pre-wrap break-all";

/** A body region for the arms that are not the output itself. */
function BodyMessage({ children }: { children: ReactNode }) {
  return (
    <Scroll axis="y" fill>
      <Stack gap="none" className="px-md py-sm">
        {children}
      </Stack>
    </Scroll>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <Text as="div" variant="caption" className="text-muted-foreground">
      {children}
    </Text>
  );
}

/**
 * Route ownership: which shell the URL names and which conversation it hangs
 * off. A conversation-scoped satellite with no conversation above it says so,
 * rather than subscribing to an empty conversation id.
 */
export function ShellOutputPaneBody() {
  const { shellId } = shellOutputPane.useParams();
  const convId = conversationPane.useRouteEntry()?.params.convId;
  return (
    <PaneChrome pane={shellOutputPane}>
      {convId === undefined ? (
        <Inset pad="lg">
          <Text as="div" variant="body" className="text-muted-foreground">
            This pane opens inside a conversation, and none is open here.
          </Text>
        </Inset>
      ) : (
        <ShellOutputView conversationId={convId} shellId={shellId} />
      )}
    </PaneChrome>
  );
}

function ShellOutputView({
  conversationId,
  shellId,
}: {
  conversationId: string;
  shellId: string;
}) {
  const shells = useConversationShells(conversationId);
  const output = useShellOutput(conversationId, shellId);

  if (shells.kind === "failed") {
    return (
      <BodyMessage>
        <ResourceErrorInline
          variant="block"
          subject="the conversation's shells"
          error={shells.error}
          refetch={shells.refetch}
        />
      </BodyMessage>
    );
  }
  if (shells.kind === "pending") {
    return (
      <BodyMessage>
        <Loading />
      </BodyMessage>
    );
  }
  const shell = shells.shells.find((s) => s.shellId === shellId);
  if (shell === undefined) {
    return (
      <BodyMessage>
        <Muted>This conversation has no background shell with that id.</Muted>
      </BodyMessage>
    );
  }

  return (
    <Stack gap="none" className="h-full min-h-0">
      <ShellHeader shell={shell} />
      {output.status === "loading" ? (
        <BodyMessage>
          <Loading />
        </BodyMessage>
      ) : output.status === "unavailable" ? (
        <BodyMessage>
          <Muted>{output.message}</Muted>
        </BodyMessage>
      ) : output.status === "error" ? (
        <BodyMessage>
          <ResourceErrorInline
            variant="block"
            subject="the shell's output"
            error={output.error}
            refetch={output.refetch}
          />
        </BodyMessage>
      ) : (
        <ShellOutputBody
          output={output.data}
          running={shell.state.kind === "running"}
        />
      )}
    </Stack>
  );
}

function ShellHeader({ shell }: { shell: BackgroundShell }) {
  return (
    <Stack
      gap="2xs"
      className={cn(rigidClass(), "border-b border-border/60 px-md py-sm")}
    >
      <Line className="gap-sm">
        <Fill>
          <Text className={cn(MONO, "line-clamp-3")} title={shell.command}>
            $ {shell.command}
          </Text>
        </Fill>
        <ShellStateChip shell={shell} className={rigidClass()} />
      </Line>
      {shell.description !== undefined && <Muted>{shell.description}</Muted>}
      <Line className="gap-xs">
        <Fill>
          <Text
            variant="caption"
            className="font-mono text-muted-foreground"
            title={shell.outputFile}
          >
            {shell.outputFile}
          </Text>
        </Fill>
        <CopyButton text={shell.outputFile} tooltip="Copy output file path" />
      </Line>
    </Stack>
  );
}

function ShellOutputBody({
  output,
  running,
}: {
  output: ShellOutput;
  running: boolean;
}) {
  switch (output.kind) {
    case "unknown-shell":
      return (
        <BodyMessage>
          <Muted>
            The server found no background launch with this id in the
            conversation&apos;s transcript.
          </Muted>
        </BodyMessage>
      );
    case "gone":
      return (
        <BodyMessage>
          <Muted>
            The output file is gone — its temporary directory was cleaned up, or
            the machine restarted.
          </Muted>
        </BodyMessage>
      );
    case "present":
      return (
        <OutputTail
          tail={output.tail}
          truncated={output.truncated}
          running={running}
        />
      );
  }
}

/**
 * The tail itself, following the bottom as it grows unless the reader has
 * scrolled away (then a Jump to bottom button offers the ride back).
 */
function OutputTail({
  tail,
  truncated,
  running,
}: {
  tail: string;
  truncated: boolean;
  running: boolean;
}) {
  const { scrollRef, bottomSentinel, isFollowing, jumpToBottom } =
    useStickyScroll();
  const text = terminalText(tail);
  return (
    <div className={cn("relative min-h-0", growClass())}>
      <Scroll axis="y" fill ref={scrollRef} className="h-full px-md py-sm">
        {truncated && <Muted>Showing the last 64 KB.</Muted>}
        {text.trim() === "" ? (
          <Muted>
            {running ? "No output yet." : "The shell printed nothing."}
          </Muted>
        ) : (
          <Text as="pre" variant="caption" className={MONO}>
            {text}
          </Text>
        )}
        {bottomSentinel}
      </Scroll>
      <Pin to="bottom" style={{ bottom: "0.25rem" }}>
        <JumpToBottomButton handle={{ isFollowing, jumpToBottom }} />
      </Pin>
    </div>
  );
}
