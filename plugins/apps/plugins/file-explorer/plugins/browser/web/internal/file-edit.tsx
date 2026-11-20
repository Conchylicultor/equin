import { useCallback, useMemo, useState } from "react";
import { useStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import {
  clearDraft,
  defineKept,
  readDraft,
  useKept,
  writeDraft,
} from "@plugins/primitives/plugins/kept-state/web";
import type {
  BrowsableFileSystem,
  FileWriteResult,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFileEdits } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useConfirm } from "../components/confirm-dialog";
import { baseName } from "../../core";

/**
 * An edit of a text file not saved yet: the text being typed, and the text
 * the file held when the edit began (`base`) — what a save checks the file
 * still holds, so a change made meanwhile (by an agent, another editor) is
 * never overwritten unasked. Work: kept across a reload and a tab switch, one
 * entry per file (`fs:path`), so two previews of one file share it, and it
 * follows the file through a rename (`moveFileEdit`).
 */
const fileEditDraft = defineKept({
  owner: "file-explorer.file-edit",
  label: "Unsaved file edits",
  tier: "work",
  stamp: "15zrbpn7cz8",
  cap: "1 MB",
  // `null`: no edit (the entry is cleared, never written as null).
  schema: z.object({ base: z.string(), text: z.string() }).nullable(),
});

/**
 * The longest text the preview edits in place, in characters: its edit is
 * kept twice over (base and text) in browser storage, under the store's cap.
 */
export const FILE_EDIT_MAX_CHARS = 200_000;

function subjectOf(fs: BrowsableFileSystem, path: string): string {
  return `${fs}:${path}`;
}

/**
 * The edits of this surface's storage scope, outside any one preview: open a
 * file for editing before its preview mounts (`begin` — a file just created
 * opens straight into the editor, `base` its content), and carry an unsaved
 * edit along with its file's rename (`move`).
 */
export function useFileEditDrafts(): {
  begin: (fs: BrowsableFileSystem, path: string, base: string) => void;
  move: (fs: BrowsableFileSystem, from: string, to: string) => void;
} {
  const store = useStore(fileEditDraft.store);
  return useMemo(
    () => ({
      begin: (fs, path, base) =>
        writeDraft(store, { base, text: base }, { scope: subjectOf(fs, path) }),
      move: (fs, from, to) => {
        const draft = readDraft(store, { scope: subjectOf(fs, from) });
        if (draft === null) return;
        writeDraft(store, draft, { scope: subjectOf(fs, to) });
        clearDraft(store, { scope: subjectOf(fs, from) });
      },
    }),
    [store],
  );
}

/** A system's write, as `useFileEdits` binds it where the host can run it. */
type AvailableWrite = Exclude<
  ReturnType<typeof useFileEdits>["write"],
  { kind: "unavailable" }
>;

/**
 * Send one save, `saving` held while it is in flight: its answer, or `null`
 * when the request failed — which the endpoint's error toast already says;
 * the edit stays, to be saved again.
 */
async function sendWrite(
  write: AvailableWrite,
  setSaving: (saving: boolean) => void,
  body: { path: string; text: string; expected?: string },
): Promise<FileWriteResult | null> {
  setSaving(true);
  try {
    return await write.mutateAsync({ body });
  } catch (err) {
    if (err instanceof EndpointError) return null;
    throw err;
  } finally {
    setSaving(false);
  }
}

/** The preview's edit of a file: off, or the text being typed. */
export type FileEditSession =
  | {
      kind: "off";
      /** Begin editing, from the file's current `content`. */
      start: (content: string) => void;
    }
  | {
      kind: "editing";
      text: string;
      /** Whether `text` differs from what the file held when the edit began. */
      dirty: boolean;
      setText: (text: string) => void;
      /** Write it; the edit ends once the file holds it. */
      save: () => Promise<void>;
      saving: boolean;
      /** Drop the edit: the file stays as it is. */
      revert: () => void;
      /**
       * The editor takes the focus as it opens: the person pressed Edit here
       * (not a new file opened beside its name being typed, nor a reload).
       */
      focus: boolean;
    };

/**
 * The edit session of the file `path` of `fs`, for its preview: the kept
 * draft, and its save through the system's write. `null` where this host
 * cannot write the system (the computer's disk in the in-browser demo).
 */
export function useFileEdit({
  fs,
  path,
}: {
  fs: BrowsableFileSystem;
  path: string;
}): FileEditSession | null {
  const [draft, setDraft, clear] = useKept(fileEditDraft, null, {
    subject: subjectOf(fs, path),
  });
  const edits = useFileEdits(fs);
  const toast = useToast();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [startedHere, setStartedHere] = useState(false);

  const write = edits.write;
  const save = useCallback(async () => {
    if (draft === null || write.kind === "unavailable") return;
    const send = (expected: string | undefined) =>
      sendWrite(write, setSaving, {
        path,
        text: draft.text,
        ...(expected !== undefined ? { expected } : {}),
      });
    let result = await send(draft.base);
    if (result?.kind === "changed") {
      const overwrite = await confirm({
        title: `“${baseName(path)}” changed since you began editing`,
        description:
          "Something else saved this file meanwhile. Overwrite those changes with yours? Cancel keeps your edit open.",
        confirm: "Overwrite",
        destructive: true,
      });
      if (!overwrite) return;
      result = await send(undefined);
    }
    if (result === null) return;
    switch (result.kind) {
      case "written":
        clear();
        return;
      case "changed":
        // Changed again while the dialog was open: said, not asked twice.
        toast({
          type: "file-explorer-save-changed",
          variant: "error",
          title: `“${baseName(path)}” changed while saving`,
          description: "Your edit is kept: save again to overwrite it.",
          category: "other",
        });
        return;
      case "missing":
      case "denied":
      case "not-a-file":
      case "archive":
        toast({
          type: "file-explorer-save-refused",
          variant: "error",
          title: `Couldn't save “${baseName(path)}”`,
          description:
            result.kind === "missing"
              ? "This file no longer exists."
              : result.kind === "denied"
                ? "Permission denied."
                : result.kind === "not-a-file"
                  ? "It is not a file."
                  : "It cannot be changed where it is.",
          category: "other",
        });
        return;
    }
  }, [draft, write, path, confirm, toast, clear]);

  if (write.kind === "unavailable") return null;
  if (draft === null) {
    return {
      kind: "off",
      start: (content) => {
        setStartedHere(true);
        setDraft({ base: content, text: content });
      },
    };
  }
  return {
    kind: "editing",
    text: draft.text,
    dirty: draft.text !== draft.base,
    setText: (text) => setDraft({ base: draft.base, text }),
    save,
    saving,
    revert: clear,
    focus: startedHere,
  };
}
