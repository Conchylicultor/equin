import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The checkout a subtree's file paths name: what a bare `research/foo.md` in
 * rendered text is relative to. `workspace` is the worktree id the file
 * readers take (an attempt id, or `"main"`); `root` is its absolute checkout
 * path when known, so an absolute path inside it reads from the checkout too.
 */
export interface FileLinksWorkspace {
  workspace: string;
  root?: string;
}

const FileLinksWorkspaceContext = createContext<FileLinksWorkspace | undefined>(
  undefined,
);

/**
 * Declares the checkout file paths below it belong to. SUPPLIED by whoever
 * hosts the content (a conversation pane, a task detail, a file peek, a
 * global card asking about `main`) — never guessed from the route, which
 * global chrome cannot read. Nested providers: the nearest wins.
 *
 * `workspace: undefined` is a host saying "not known (yet)": its paths stay
 * plain, and it still shadows any outer provider — the content is this
 * host's, not the outer one's. Always rendered (never swapped in once the
 * workspace arrives), so the subtree does not remount when it does.
 */
export function FileLinksWorkspaceProvider({
  workspace,
  root,
  children,
}: {
  workspace: string | undefined;
  root?: string | undefined;
  children: ReactNode;
}) {
  const value = useMemo((): FileLinksWorkspace | undefined => {
    if (workspace === undefined) return undefined;
    return root !== undefined ? { workspace, root } : { workspace };
  }, [workspace, root]);
  return (
    <FileLinksWorkspaceContext.Provider value={value}>
      {children}
    </FileLinksWorkspaceContext.Provider>
  );
}

/**
 * The checkout the nearest `FileLinksWorkspaceProvider` declares, or
 * `undefined` outside every one — a true answer, not a stand-in: no host said
 * which checkout the text is about, so its paths stay plain text.
 */
export function useFileLinksWorkspace(): FileLinksWorkspace | undefined {
  return useContext(FileLinksWorkspaceContext);
}
