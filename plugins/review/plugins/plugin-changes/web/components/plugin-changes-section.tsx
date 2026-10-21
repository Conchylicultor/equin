import type { Source } from "@plugins/review/web";
import { useWorktreePluginChanges, usePushPluginChanges } from "../use-plugin-changes";
import { PluginChangesList } from "./plugin-changes-list";

function WorktreePluginChanges({ conversationId }: { conversationId: string }) {
  const result = useWorktreePluginChanges(conversationId);
  return <PluginChangesList conversationId={conversationId} {...result} />;
}

function PushPluginChanges({
  conversationId,
  pushId,
}: {
  conversationId: string;
  pushId: string;
}) {
  const result = usePushPluginChanges(pushId);
  return <PluginChangesList conversationId={conversationId} {...result} />;
}

export function PluginChangesSection({
  conversationId,
  source,
}: {
  conversationId: string;
  source: Source;
}) {
  if (source.kind === "push") {
    return (
      <PushPluginChanges
        conversationId={conversationId}
        pushId={source.pushId}
      />
    );
  }
  return <WorktreePluginChanges conversationId={conversationId} />;
}
