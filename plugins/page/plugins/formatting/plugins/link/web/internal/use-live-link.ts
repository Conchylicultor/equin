import { useCallback, useMemo, useSyncExternalStore } from "react";
import { $getNodeByKey, type LexicalEditor, type NodeKey } from "lexical";
import { $isLinkNode } from "@lexical/link";

/**
 * The link's live href + text, re-read on every editor update, or null once
 * the node is gone. The snapshot is a JSON pair so `useSyncExternalStore` gets
 * a value that compares equal while nothing changed.
 */
export function useLiveLink(
  lexical: LexicalEditor,
  key: NodeKey | null,
): { url: string; text: string } | null {
  const subscribe = useCallback(
    (onChange: () => void) => lexical.registerUpdateListener(onChange),
    [lexical],
  );
  const read = useCallback(
    () =>
      key === null
        ? null
        : lexical.getEditorState().read(() => {
            const node = $getNodeByKey(key);
            return $isLinkNode(node)
              ? JSON.stringify([node.getURL(), node.getTextContent()])
              : null;
          }),
    [lexical, key],
  );
  // The editor state is in memory: a static render reads the same link.
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    if (snapshot === null) return null;
    const [url, text] = JSON.parse(snapshot) as [string, string];
    return { url, text };
  }, [snapshot]);
}
