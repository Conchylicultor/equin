import { useCallback } from "react";
import {
  absolutePath,
  displayPath,
} from "@plugins/infra/plugins/host-account/core";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import {
  computerFileCompress,
  computerFileCopy,
  isValidEntryName,
  type FileRemoveResult,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFileEdits } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { useToast, type Toast } from "@plugins/shell/plugins/notifications/web";
import { baseName } from "../../core";
import { useConfirm } from "../components/confirm-dialog";
import type { ExplorerSystem } from "./explorer-system";

/** What a new entry is called before the person names it (the Finder's words). */
const UNTITLED = { file: "untitled.txt", dir: "untitled folder" } as const;

/** How a removal goes: to the Trash (put back later), or for good. */
export type RemoveMode = "trash" | "delete";

/**
 * The edits a browser makes to the entries of its system, in its display
 * form (`~/…`): each sends the system's edit, says a refusal in one toast, and
 * answers what changed — `null` where nothing did (refused, cancelled, or
 * the request failed, which the endpoint's own error toast says).
 */
export interface EntryEdits {
  /** Rename `path` to `name` in place: the new path. */
  rename: (path: string, name: string) => Promise<string | null>;
  /** A new empty file or folder in `dir`, named untitled: its path. */
  create: (dir: string, kind: "file" | "dir") => Promise<string | null>;
  /**
   * Remove `paths` (asking first for a deletion for good): the paths removed.
   * `trash` only where the system has a Trash.
   */
  remove: (paths: readonly string[], mode: RemoveMode) => Promise<string[]>;
  /**
   * Copy `paths` (absolute — a clipboard's) into `dir`: the copies' paths. A
   * taken name gets the next free one. Only where the system copies.
   */
  copy: (paths: readonly string[], dir: string) => Promise<string[]>;
  /** A .zip of `paths` (entries of one folder) beside them: its path. Only where the system compresses. */
  compress: (paths: readonly string[]) => Promise<string | null>;
}

function refused(toast: Toast, title: string, description = ""): void {
  toast({
    type: "file-explorer-edit-refused",
    variant: "error",
    title,
    description,
    category: "other",
  });
}

/** Sends one edit, a failed request answered `null` (its toast is the endpoint's). */
async function sent<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof EndpointError) return null;
    throw err;
  }
}

/** The edits of `system` (see {@link EntryEdits}); `null` where it has none here. */
export function useEntryEdits(system: ExplorerSystem): EntryEdits | null {
  const edits = useFileEdits(system.fs);
  const toast = useToast();
  const confirm = useConfirm();
  const { home } = system;
  const abs = useCallback((path: string) => absolutePath(path, home), [home]);
  const shown = useCallback((path: string) => displayPath(path, home), [home]);
  const { rename, create, delete: del, trash } = edits;
  const copyInto = useEndpointMutation(computerFileCopy);
  const compressAt = useEndpointMutation(computerFileCompress);

  const renameEntry = useCallback(
    async (path: string, name: string): Promise<string | null> => {
      if (rename.kind === "unavailable") return null;
      const wanted = name.trim();
      if (wanted === baseName(path)) return null;
      if (!isValidEntryName(wanted)) {
        refused(
          toast,
          `“${wanted}” can't be used as a name`,
          "A name can't be empty, “.” or “..”, or contain “/”.",
        );
        return null;
      }
      const result = await sent(
        rename.mutateAsync({ body: { path: abs(path), name: wanted } }),
      );
      if (result === null) return null;
      switch (result.kind) {
        case "renamed":
          return shown(result.to);
        case "exists":
          refused(
            toast,
            `The name “${wanted}” is already taken`,
            "Please choose a different name.",
          );
          return null;
        case "invalid-name":
          refused(toast, `“${wanted}” can't be used as a name`);
          return null;
        case "missing":
          refused(toast, `“${baseName(path)}” no longer exists`);
          return null;
        case "denied":
          refused(
            toast,
            `You don't have permission to rename “${baseName(path)}”`,
          );
          return null;
        case "archive":
          refused(toast, `“${baseName(path)}” can't be renamed where it is`);
          return null;
      }
    },
    [rename, abs, shown, toast],
  );

  const createEntry = useCallback(
    async (dir: string, kind: "file" | "dir"): Promise<string | null> => {
      if (create.kind === "unavailable") return null;
      const result = await sent(
        create.mutateAsync({
          body: { dir: abs(dir), name: UNTITLED[kind], kind },
        }),
      );
      if (result === null) return null;
      switch (result.kind) {
        case "created":
          return shown(result.path);
        case "denied":
          refused(
            toast,
            `You don't have permission to add items to “${baseName(dir)}”`,
          );
          return null;
        case "missing":
          refused(toast, `“${baseName(dir)}” no longer exists`);
          return null;
        case "not-a-dir":
          refused(toast, `“${baseName(dir)}” is not a folder`);
          return null;
        case "archive":
          refused(toast, `Items can't be added to “${baseName(dir)}”`);
          return null;
        case "invalid-name":
          throw new Error(
            `file-explorer: the untitled name “${result.name}” was refused`,
          );
      }
    },
    [create, abs, shown, toast],
  );

  const removeEntries = useCallback(
    async (paths: readonly string[], mode: RemoveMode): Promise<string[]> => {
      const mutation = mode === "trash" ? trash : del;
      if (mutation === null || mutation.kind === "unavailable") return [];
      if (mode === "delete") {
        const yes = await confirm({
          title:
            paths.length === 1
              ? `Delete “${baseName(paths[0]!)}” permanently?`
              : `Delete ${paths.length} items permanently?`,
          description: "This can't be undone.",
          confirm: "Delete",
          destructive: true,
        });
        if (!yes) return [];
      }
      const result: FileRemoveResult | null = await sent(
        mutation.mutateAsync({ body: { paths: paths.map(abs) } }),
      );
      if (result === null) return [];
      const removed: string[] = [];
      const why: string[] = [];
      result.results.forEach((outcome, i) => {
        const name = `“${baseName(paths[i]!)}”`;
        switch (outcome.kind) {
          case "removed":
            removed.push(paths[i]!);
            return;
          case "missing":
            why.push(`${name} no longer exists`);
            return;
          case "denied":
            why.push(`${name}: permission denied`);
            return;
          case "archive":
            why.push(`${name} can't be removed from where it is`);
            return;
        }
      });
      if (why.length > 0) {
        refused(
          toast,
          why.length === 1
            ? why[0]!
            : `${why.length} items were not ${mode === "trash" ? "moved to the Trash" : "deleted"}`,
          why.length === 1 ? "" : why.join("; "),
        );
      }
      return removed;
    },
    [trash, del, abs, confirm, toast],
  );

  const copyEntries = useCallback(
    async (paths: readonly string[], dir: string): Promise<string[]> => {
      if (copyInto.kind === "unavailable") return [];
      const result = await sent(
        copyInto.mutateAsync({
          body: { sources: [...paths], destDir: abs(dir) },
        }),
      );
      if (result === null) return [];
      switch (result.kind) {
        case "missing":
          refused(toast, `“${baseName(dir)}” no longer exists`);
          return [];
        case "denied":
          refused(
            toast,
            `You don't have permission to add items to “${baseName(dir)}”`,
          );
          return [];
        case "not-a-dir":
          refused(toast, `“${baseName(dir)}” is not a folder`);
          return [];
        case "archive":
          refused(toast, `Items can't be pasted into “${baseName(dir)}”`);
          return [];
        case "ok":
          break;
      }
      const copied: string[] = [];
      const why: string[] = [];
      for (const outcome of result.results) {
        const name = `“${baseName(outcome.from)}”`;
        switch (outcome.kind) {
          case "copied":
            copied.push(shown(outcome.to));
            break;
          case "into-self":
            why.push(`${name} can't be pasted into itself`);
            break;
          case "missing":
            why.push(`${name} no longer exists`);
            break;
          case "denied":
            why.push(`${name}: permission denied`);
            break;
          case "archive":
            why.push(`${name} can't be copied from where it is`);
            break;
        }
      }
      if (why.length > 0) {
        refused(
          toast,
          why.length === 1 ? why[0]! : `${why.length} items were not pasted`,
          why.length === 1 ? "" : why.join("; "),
        );
      }
      return copied;
    },
    [copyInto, abs, shown, toast],
  );

  const compressEntries = useCallback(
    async (paths: readonly string[]): Promise<string | null> => {
      if (compressAt.kind === "unavailable") return null;
      const result = await sent(
        compressAt.mutateAsync({ body: { paths: paths.map(abs) } }),
      );
      if (result === null) return null;
      switch (result.kind) {
        case "compressed":
          return shown(result.path);
        case "missing":
          refused(toast, `“${baseName(result.path)}” no longer exists`);
          return null;
        case "denied":
          refused(
            toast,
            `You don't have permission to compress in “${baseName(result.path)}”`,
          );
          return null;
        case "archive":
          refused(
            toast,
            `“${baseName(result.path)}” can't be compressed where it is`,
          );
          return null;
        case "mixed-folders":
          refused(toast, "Only items of one folder can be compressed together");
          return null;
      }
    },
    [compressAt, abs, shown, toast],
  );

  if (!system.capabilities.edit) return null;
  return {
    rename: renameEntry,
    create: createEntry,
    remove: removeEntries,
    copy: copyEntries,
    compress: compressEntries,
  };
}
