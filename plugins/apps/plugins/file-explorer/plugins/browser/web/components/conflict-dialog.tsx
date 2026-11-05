import { useCallback, useState, type ReactNode } from "react";
import {
  Button,
  DialogDescription,
  DialogTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import type { HostFsMoveResolution } from "@plugins/infra/plugins/host-fs/core";

/** What the person chose for one name collision of a move. */
export type ConflictAnswer =
  | { kind: "resolve"; resolution: HostFsMoveResolution; applyToAll: boolean }
  /** Cancel, Escape or a press outside: this one and every later one skipped. */
  | { kind: "cancel" };

/** One collision to ask about. */
interface Conflict {
  name: string;
  destName: string;
  /** How many collisions come after this one. */
  remaining: number;
}

/**
 * This surface's conflict question (in its render origin): ask what to do with one entry whose name is already taken in the folder it
 * is being moved into: Replace / Keep both / Skip, and — while more
 * collisions wait behind this one — "Apply to all N remaining".
 */
export function useAskConflict(): (
  conflict: Conflict,
) => Promise<ConflictAnswer> {
  const openDialog = useOpenDialog();
  return useCallback(
    (conflict) => {
      let answer: ConflictAnswer = { kind: "cancel" };
      return openDialog(
        (close) => (
          <ConflictDialogBody
            {...conflict}
            onAnswer={(a) => {
              answer = a;
              close();
            }}
          />
        ),
        { size: "sm" },
      ).then(() => answer);
    },
    [openDialog],
  );
}

function ConflictDialogBody({
  name,
  destName,
  remaining,
  onAnswer,
}: {
  name: string;
  destName: string;
  remaining: number;
  onAnswer: (answer: ConflictAnswer) => void;
}): ReactNode {
  const [applyToAll, setApplyToAll] = useState(false);
  const resolve = (resolution: HostFsMoveResolution) =>
    onAnswer({ kind: "resolve", resolution, applyToAll });
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <DialogTitle>
          “{name}” already exists in “{destName}”
        </DialogTitle>
        <DialogDescription>
          Replace it with the one you are moving, keep both, or skip this one.
        </DialogDescription>
      </Stack>
      {remaining > 0 && (
        <Stack as="label" direction="row" align="center" gap="sm">
          {/* The sanctioned native checkbox (see fields/bool filter). */}
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            className="size-4 accent-primary"
          />
          <Text variant="body">Apply to all {remaining} remaining</Text>
        </Stack>
      )}
      <Stack direction="row" align="center" gap="sm">
        <Button variant="ghost" onClick={() => onAnswer({ kind: "cancel" })}>
          Cancel
        </Button>
        <Fill />
        <Button variant="outline" onClick={() => resolve("skip")}>
          Skip
        </Button>
        <Button variant="outline" onClick={() => resolve("keep-both")}>
          Keep both
        </Button>
        <Button variant="destructive" onClick={() => resolve("replace")}>
          Replace
        </Button>
      </Stack>
    </Stack>
  );
}
