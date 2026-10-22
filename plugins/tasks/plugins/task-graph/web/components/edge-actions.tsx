import { useCallback, useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { removeTaskDependency, insertTaskBetween } from "@plugins/tasks/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export type EdgeActionsProps = {
  sourceTaskId: string;
  targetTaskId: string;
  targetFolderId: string | null;
  onNavigate: (taskId: string) => void;
};

/**
 * The "+"/"×" buttons rendered as a graph-canvas edge `actions` overlay. The
 * primitive owns the edge path, hit area, hover reveal, and mid-edge placement;
 * this owns only the buttons and their task-domain endpoint calls.
 */
export function EdgeActions({
  sourceTaskId,
  targetTaskId,
  targetFolderId,
  onNavigate,
}: EdgeActionsProps) {
  const [inserting, setInserting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fetchEndpoint = useFetchEndpoint();

  const handleInsert = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (inserting) return;
      setInserting(true);
      try {
        const newTask = await fetchEndpoint(
          insertTaskBetween,
          {},
          { body: { sourceTaskId, targetTaskId, targetFolderId } },
        );
        onNavigate(newTask.id);
      } finally {
        setInserting(false);
      }
    },
    [
      inserting,
      sourceTaskId,
      targetTaskId,
      targetFolderId,
      onNavigate,
      fetchEndpoint,
    ],
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (deleting) return;
      setDeleting(true);
      try {
        await fetchEndpoint(removeTaskDependency, {
          id: targetTaskId,
          depId: sourceTaskId,
        });
      } finally {
        setDeleting(false);
      }
    },
    [deleting, targetTaskId, sourceTaskId, fetchEndpoint],
  );

  return (
    <>
      <Button
        variant="floating"
        aspect="icon"
        // eslint-disable-next-line control-size/no-adhoc-density -- custom-chrome graph-node action, intentional fixed 24px
        className="hover:bg-primary hover:text-primary-foreground size-6 rounded-full"
        disabled={inserting}
        onClick={handleInsert}
        aria-label="Insert task"
      >
        <Text variant="label">+</Text>
      </Button>
      <Button
        variant="floating"
        aspect="icon"
        // eslint-disable-next-line control-size/no-adhoc-density -- custom-chrome graph-node action, intentional fixed 24px
        className="hover:bg-destructive hover:text-destructive-foreground size-6 rounded-full"
        disabled={deleting}
        onClick={handleDelete}
        aria-label="Remove dependency"
      >
        <Text variant="label">&times;</Text>
      </Button>
    </>
  );
}
