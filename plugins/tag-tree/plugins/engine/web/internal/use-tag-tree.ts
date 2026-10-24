import { useMemo } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { CollectionRow } from "@plugins/network/plugins/live/core";
import {
  createTag,
  createTagPath,
  deleteTag,
  moveTag,
  updateTag,
  type CreateTagBody,
  type CreateTagPathResult,
  type MoveTagBody,
  type TagRow,
  type TagTree,
  type UpdateTagBody,
} from "../../core";

/** A tree's rows, live, in rank order — the whole tree. */
export function useTagTree<Row extends TagRow>(
  tree: TagTree<Row>,
): ResourceResult<CollectionRow<Row>[]> {
  return useLive(tree.collection);
}

/** A tree's writes: the engine's five endpoints, bound to the tree. */
export interface TagTreeActions {
  create(body: CreateTagBody): Promise<{ id: string }>;
  createPath(segments: readonly string[]): Promise<CreateTagPathResult>;
  update(id: string, body: UpdateTagBody): Promise<void>;
  move(id: string, dest: MoveTagBody): Promise<void>;
  remove(id: string): Promise<void>;
  /** Any of them is in flight. */
  pending: boolean;
}

/**
 * The tree's writes (`useEndpointMutation` over the engine's endpoints with
 * `params.tree = tree.id`). A failure toasts (the global mutation handler)
 * and rejects; the rows change through `useTagTree`.
 */
export function useTagTreeActions<Row extends TagRow>(
  tree: TagTree<Row>,
): TagTreeActions {
  const treeId = tree.id;
  const create = useEndpointMutation(createTag);
  const createPath = useEndpointMutation(createTagPath);
  const update = useEndpointMutation(updateTag);
  const move = useEndpointMutation(moveTag);
  const remove = useEndpointMutation(deleteTag);
  const pending =
    create.isPending ||
    createPath.isPending ||
    update.isPending ||
    move.isPending ||
    remove.isPending;
  const createAsync = create.mutateAsync;
  const createPathAsync = createPath.mutateAsync;
  const updateAsync = update.mutateAsync;
  const moveAsync = move.mutateAsync;
  const removeAsync = remove.mutateAsync;
  return useMemo(
    () => ({
      create: (body) => createAsync({ params: { tree: treeId }, body }),
      createPath: (segments) =>
        createPathAsync({
          params: { tree: treeId },
          body: { segments: [...segments] },
        }),
      update: (id, body) => updateAsync({ params: { tree: treeId, id }, body }),
      move: (id, dest) =>
        moveAsync({ params: { tree: treeId, id }, body: dest }),
      remove: (id) => removeAsync({ params: { tree: treeId, id } }),
      pending,
    }),
    [
      treeId,
      createAsync,
      createPathAsync,
      updateAsync,
      moveAsync,
      removeAsync,
      pending,
    ],
  );
}
