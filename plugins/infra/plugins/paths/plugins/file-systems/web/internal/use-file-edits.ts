import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  browserFileCreate,
  browserFileDelete,
  browserFileRename,
  browserFileWrite,
  computerFileCreate,
  computerFileDelete,
  computerFileRename,
  computerFileTrash,
  computerFileWrite,
  type BrowsableFileSystem,
} from "../../core";

/**
 * The edits of `fs` (create, rename, delete, save text; and move to the Trash
 * where the system has one) — one mutation shape per edit whichever system:
 * `unavailable` where this host cannot run it (the computer's disk in the
 * in-browser demo). Every system's mutations are declared every render
 * (hooks cannot be conditional); only `fs`'s are used. `trash` is `null` for
 * a system without a Trash (`FILE_SYSTEMS[fs].capabilities.trash`).
 */
// The return type is the computer's mutations (`unavailable | available`),
// which the browser's always-available ones are lifted into.
export function useFileEdits(fs: BrowsableFileSystem) {
  const computer = {
    create: useEndpointMutation(computerFileCreate),
    rename: useEndpointMutation(computerFileRename),
    delete: useEndpointMutation(computerFileDelete),
    write: useEndpointMutation(computerFileWrite),
    trash: useEndpointMutation(computerFileTrash),
  };
  const browser = {
    create: useEndpointMutation(browserFileCreate),
    rename: useEndpointMutation(browserFileRename),
    delete: useEndpointMutation(browserFileDelete),
    write: useEndpointMutation(browserFileWrite),
  };
  switch (fs) {
    case "computer":
      return computer;
    case "browser":
      return {
        create: { kind: "available" as const, ...browser.create },
        rename: { kind: "available" as const, ...browser.rename },
        delete: { kind: "available" as const, ...browser.delete },
        write: { kind: "available" as const, ...browser.write },
        trash: null,
      };
  }
}

/** The edits of one file system, as {@link useFileEdits} binds them. */
export type FileEdits = ReturnType<typeof useFileEdits>;
