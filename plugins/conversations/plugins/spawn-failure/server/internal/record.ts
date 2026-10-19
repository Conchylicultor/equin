import type { SpawnStep } from "../../core";
import { spawnFailures } from "./tables";

/** Record a failed spawn attempt — overwrites the previous attempt's, so the row is always the latest. */
export async function recordSpawnFailure(
  conversationId: string,
  step: SpawnStep,
  message: string,
): Promise<void> {
  await spawnFailures.upsert(conversationId, {
    step,
    message,
    failedAt: new Date(),
  });
}

/** A session started: whatever an earlier attempt failed on no longer describes the conversation. */
export async function clearSpawnFailure(conversationId: string): Promise<void> {
  await spawnFailures.delete(conversationId);
}
