import {
  useLive,
  type LiveListResult,
  type LiveRowResult,
} from "@plugins/network/plugins/live/web";
import { promptBlockTasks, type PromptTaskLink } from "../shared/schemas";

// The tasks one prompt block has launched, newest first (the collection's
// default window). Derived entirely from the link rows — the block stores no
// task ids — so a deleted task drops out on its own (FK CASCADE) and a launch
// from another tab shows up live. "Not loaded yet" stays the pending arm; the
// caller decides what a block that has not loaded renders.
export function useBlockPromptTasks(
  blockId: string,
): LiveListResult<PromptTaskLink> {
  return useLive(promptBlockTasks, { where: { blockId } });
}

// The page/block a task was launched from: its row of the link collection.
// `found: false` means the task did not come from a prompt block; "not loaded
// yet" stays the pending arm. The `blockId` may dangle — the block can be
// deleted while the task lives on — so consumers must tolerate a page/block
// that no longer exists.
export function usePromptTaskLink(
  taskId: string,
): LiveRowResult<PromptTaskLink> {
  return useLive(promptBlockTasks, { id: taskId });
}
