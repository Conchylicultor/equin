import { useLive } from "@plugins/network/plugins/live/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useConfig } from "@plugins/config_v2/web";
import { pushRows } from "@plugins/tasks/plugins/tasks-core/core";
import { useEditedFiles } from "@plugins/conversations/plugins/conversation-view/plugins/code/web";
import { useConversationById } from "@plugins/conversations/web";
import { getFileWarningLevel, type FileWarningLevel } from "../core-files";
import { reviewConfig } from "../../shared/config";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");

const WARNING_ICON_CLASS: Record<"careful" | "critical", string> = {
  careful: "size-3.5 text-warning",
  critical: "size-3.5 text-destructive",
};

export function CodeReviewSummary({
  conversationId,
}: {
  conversationId: string;
  source: unknown;
}) {
  const conversation = useConversationById(conversationId);
  // Render nothing until the conversation — and so its attempt — is known: the
  // stats row's visibility depends on that attempt's pushes.
  if (!conversation) return null;
  return (
    <AttemptCodeReviewSummary
      conversationId={conversationId}
      attemptId={conversation.attemptId}
    />
  );
}

function AttemptCodeReviewSummary({
  conversationId,
  attemptId,
}: {
  conversationId: string;
  attemptId: string;
}) {
  const filesResult = useEditedFiles(conversationId);
  const config = useConfig(reviewConfig);
  const safePaths = config.safePaths.map((p) => p.path);
  const carefulPaths = config.carefulPaths.map((p) => p.path);

  // This attempt's pushes: the `pushes` collection filtered to it — correct for
  // arbitrarily old attempts. Only emptiness is read, but the default window is
  // the same tuple the review pane's push tabs subscribe, so it costs nothing.
  const pushesQ = useLive(pushRows, { where: { attemptId } });

  // Gate: render nothing while pushes are loading so hasPastPushes is never
  // incorrectly false (which would hide the file-stats row on a past-push
  // conversation). Same gate for edited-files: collapsing loading to an empty
  // list would show a confidently-wrong "0 +0 −0" (and hide warnings) until the
  // resource settles. A failed read renders nothing here too, deliberately:
  // this is a header summary chip, and the section body (edited files) and the
  // review pane's source tabs (pushes) each render their own failure. An
  // unavailable read (edited files need the computer, which an in-browser host
  // lacks) renders nothing as well: the section body says why.
  const reads = combineResources({ pushes: pushesQ, files: filesResult });
  switch (reads.status) {
    case "loading":
    case "error":
    case "unavailable":
      return null;
    case "ready":
      break;
  }
  const { pushes, files: filesPayload } = reads.data;
  // An unresolved worktree has no measurable stats — render nothing (this chip's
  // existing absence idiom); the code-review section pane surfaces the reason.
  if (!filesPayload.resolved) return null;
  const files = filesPayload.value;

  // The read is already scoped to this conversation's attempt, so any row means a past push.
  const hasPastPushes = pushes.length > 0;

  const count = files.length;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const maxLevel: FileWarningLevel = files.reduce<FileWarningLevel>(
    (max, f) => {
      const level = getFileWarningLevel(f.path, safePaths, carefulPaths);
      if (level === "critical") return "critical";
      if (level === "careful" && max === "safe") return "careful";
      return max;
    },
    "safe",
  );

  if (count === 0 && !hasPastPushes) return null;

  return (
    <Stack
      as="span"
      direction="row"
      gap="xs"
      align="center"
      className="tabular-nums"
    >
      <Text as="span" variant="count">
        {count}
      </Text>
      <Text as="span" variant="count" className="text-success">
        +{additions}
      </Text>
      <Text as="span" variant="count" className="text-destructive">
        −{deletions}
      </Text>
      {maxLevel !== "safe" && (
        <Icon icon={warningIcon} className={WARNING_ICON_CLASS[maxLevel]} />
      )}
    </Stack>
  );
}
