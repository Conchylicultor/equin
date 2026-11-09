import { useCallback } from "react";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import type {
  BrowsableFileSystem,
  FileMoveOutcome,
  FileMoveResolution,
  FileMoveResult,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFileMove } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { baseName } from "../../core";
import { useAskConflict } from "../components/conflict-dialog";

/** The folder holding a resolved path (a move answers resolved paths). */
function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** Why a source did not move, in the user's words — `null` when it is no refusal. */
function refusal(outcome: FileMoveOutcome): string | null {
  const name = `“${baseName(outcome.from)}”`;
  switch (outcome.kind) {
    case "moved":
    case "exists":
    case "skipped":
    case "same-dir":
      return null;
    case "into-self":
      return `${name} cannot be moved into itself`;
    case "replaces-ancestor":
      return `${name} cannot replace a folder that holds it`;
    case "missing":
      return `${name} no longer exists`;
    case "denied":
      return `${name}: permission denied`;
    case "archive":
      return `${name} cannot be moved from where it is`;
  }
}

/** A destination that cannot take anything, in the user's words. */
function destinationRefusal(
  result: Exclude<FileMoveResult, { kind: "ok" }>,
): string {
  const name = `“${baseName(result.path)}”`;
  switch (result.kind) {
    case "missing":
      return `${name} no longer exists`;
    case "denied":
      return `You don't have permission to move items into ${name}`;
    case "not-a-dir":
      return `${name} is not a folder`;
    case "archive":
      return `Items cannot be moved into ${name}`;
  }
}

/**
 * Move paths of `fs` into one of its folders, the Finder's way: what does not collide moves
 * at once; each name already taken there asks (Replace / Keep both / Skip,
 * optionally for every remaining one; Cancel skips the rest), and only those
 * are sent again with their answers. Listings, peeks and stats are live
 * (pushed from a watch of each folder), so nothing is re-read by hand. Refusals (into
 * itself, missing, …) are said in one toast. Resolves with the sources that
 * moved, as given.
 */
export function useMoveInto(
  fs: BrowsableFileSystem,
): (sources: readonly string[], destDir: string) => Promise<readonly string[]> {
  const move = useFileMove(fs);
  const askConflict = useAskConflict();
  return useCallback(
    async (sources, destDir) => {
      // A system this host cannot run (the computer's disk in the demo) says
      // so and moves nothing.
      if (move.kind === "unavailable") {
        showToast({ variant: "error", description: move.message });
        return [];
      }
      const { mutateAsync } = move;
      const send = async (
        batch: readonly string[],
        resolutions?: Record<string, FileMoveResolution>,
      ): Promise<FileMoveResult | null> => {
        try {
          return await mutateAsync({
            body: {
              sources: [...batch],
              destDir,
              ...(resolutions ? { resolutions } : {}),
            },
          });
        } catch (err) {
          // A failed request is already shown by the endpoint error toast.
          if (err instanceof EndpointError) return null;
          throw err;
        }
      };

      const moved: string[] = [];
      const refused: string[] = [];
      const settle = (
        batch: readonly string[],
        result: FileMoveResult | null,
      ): { source: string; to: string }[] => {
        if (result === null) return [];
        if (result.kind !== "ok") {
          refused.push(destinationRefusal(result));
          return [];
        }
        const conflicts: { source: string; to: string }[] = [];
        result.results.forEach((outcome, i) => {
          const source = batch[i]!;
          if (outcome.kind === "moved") moved.push(source);
          else if (outcome.kind === "exists")
            conflicts.push({ source, to: outcome.to });
          else {
            const why = refusal(outcome);
            if (why !== null) refused.push(why);
          }
        });
        return conflicts;
      };

      const conflicts = settle(sources, await send(sources));
      if (conflicts.length > 0) {
        const resolutions: Record<string, FileMoveResolution> = {};
        let forAll: FileMoveResolution | null = null;
        for (const [i, { source, to }] of conflicts.entries()) {
          if (forAll === null) {
            const answer = await askConflict({
              name: baseName(to),
              destName: baseName(dirOf(to)),
              remaining: conflicts.length - i - 1,
            });
            if (answer.kind === "cancel") break;
            if (answer.applyToAll) forAll = answer.resolution;
            resolutions[source] = answer.resolution;
          } else {
            resolutions[source] = forAll;
          }
        }
        // A skip needs no request: only what replaces or keeps both is sent.
        const retry = Object.keys(resolutions).filter(
          (s) => resolutions[s] !== "skip",
        );
        if (retry.length > 0) {
          const again = settle(retry, await send(retry, resolutions));
          // Taken again since the dialog opened: said, not asked twice.
          for (const { source } of again) {
            refused.push(`“${baseName(source)}” is still taken`);
          }
        }
      }

      if (refused.length > 0) {
        showToast({
          variant: "error",
          description:
            refused.length === 1
              ? refused[0]!
              : `${refused.length} items were not moved: ${refused.join("; ")}`,
        });
      }
      return moved;
    },
    [move, askConflict],
  );
}
