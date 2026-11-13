import type { ReactNode } from "react";
import {
  ToolCode,
  ToolCodeEmpty,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { terminalText } from "../../core";
import { useShellOutput } from "../internal/use-conversation-shells";

/**
 * One shell's output as a transcript card's Output section — the same section
 * a `Bash` call's result draws. Subscribes to the output tail when it mounts,
 * so a card that holds it only while open reads the file only then.
 */
export function ShellOutputSection({
  conversationId,
  shellId,
}: {
  conversationId: string;
  shellId: string;
}) {
  const output = useShellOutput(conversationId, shellId);
  if (output.status === "loading") {
    return (
      <ToolSection label="Output">
        {/* The section pads nothing: the state opens a region on the
            notices' edge (`px-smd`). */}
        <div className="rail-x-smd">
          <Loading />
        </div>
      </ToolSection>
    );
  }
  if (output.status === "unavailable") {
    return (
      <ToolSection label="Output">
        <Notice>{output.message}</Notice>
      </ToolSection>
    );
  }
  if (output.status === "error") {
    return (
      <ToolSection label="Output">
        <ResourceErrorInline
          variant="block"
          subject="the shell's output"
          error={output.error}
          refetch={output.refetch}
        />
      </ToolSection>
    );
  }
  const data = output.data;
  switch (data.kind) {
    case "unknown-shell":
      return (
        <ToolSection label="Output">
          <Notice>
            The server found no background launch with this id in the
            conversation&apos;s transcript.
          </Notice>
        </ToolSection>
      );
    case "gone":
      return (
        <ToolSection label="Output">
          <Notice>
            The output file is gone — its temporary directory was cleaned up, or
            the machine restarted.
          </Notice>
        </ToolSection>
      );
    case "present": {
      const text = terminalText(data.tail);
      return (
        <ToolSection label="Output" copyText={text}>
          <ToolCode>
            {data.truncated && (
              <ToolCodeEmpty>{"Showing the last 64 KB.\n"}</ToolCodeEmpty>
            )}
            {text.trim() === "" ? (
              <ToolCodeEmpty>(no output)</ToolCodeEmpty>
            ) : (
              text
            )}
          </ToolCode>
        </ToolSection>
      );
    }
  }
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <Text as="div" variant="caption" tone="muted" className="px-smd pb-sm">
      {children}
    </Text>
  );
}
