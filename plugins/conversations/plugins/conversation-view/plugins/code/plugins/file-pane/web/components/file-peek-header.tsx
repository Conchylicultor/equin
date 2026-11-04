import { createContext, useContext, type ReactNode } from "react";
import { FilepathBreadcrumb } from "@plugins/primitives/plugins/filepath-breadcrumb/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  PathBar,
  type PathTarget,
} from "@plugins/primitives/plugins/path-bar/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import {
  FileTabs,
  type FileRenderersHandle,
} from "@plugins/primitives/plugins/file-viewer/web";
import type { FileRef } from "@plugins/primitives/plugins/file-viewer/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useFileHostPath,
  useHostPathSource,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";

/**
 * What the file-peek body hands its own header: the path it is showing and
 * the file it names (the requested one until resolution settles, so the
 * header reads the file's place from the first frame, in parallel with the
 * resolution), where a path-bar place goes, and the renderer tabs' state, which is body-local (`useState`
 * in file-viewer's `useFileRenderers`) and shared with the content below.
 * `renderers` is `null` while the path is still resolving or ambiguous —
 * there are no tabs to offer yet.
 */
interface FilePeekHeaderValue {
  path: string;
  file: FileRef;
  activationFor: (target: PathTarget) => Activation;
  renderers: FileRenderersHandle | null;
}

const FilePeekHeaderContext = createContext<FilePeekHeaderValue | null>(null);

export function FilePeekHeaderProvider({
  value,
  children,
}: {
  value: FilePeekHeaderValue;
  children: ReactNode;
}) {
  return (
    <FilePeekHeaderContext.Provider value={value}>
      {children}
    </FilePeekHeaderContext.Provider>
  );
}

function useFilePeekHeader(): FilePeekHeaderValue {
  const value = useContext(FilePeekHeaderContext);
  if (value === null) {
    throw new Error(
      "File-peek header item rendered outside FilePeekHeaderProvider: the " +
        "file-peek body wraps its PaneChrome in the provider, so the header " +
        "items only mount there.",
    );
  }
  return value;
}

/**
 * The file-peek pane's header title: the file's place as the Files path bar
 * (rooted at its checkout for a workspace file), every folder a link to that
 * folder's listing, then a copy of the path as shown to agents. While the
 * place is read (the checkout's root) a loading block holds the spot —
 * invisible on a fast read; a file with no place on this computer (an app
 * data file, a host without the computer) is a plain breadcrumb.
 */
export function FilePeekTitle() {
  const { path, file, activationFor } = useFilePeekHeader();
  const place = useFileHostPath(file);
  switch (place.kind) {
    case "pending":
      return <Loading variant="block" className="h-4 w-48" />;
    case "none":
      return <FilepathBreadcrumb path={path} />;
    case "ready":
      return (
        <HostPathBar
          home={place.home}
          root={place.root}
          path={place.path}
          copyText={path}
          activationFor={activationFor}
        />
      );
  }
}

function HostPathBar({
  home,
  root,
  path,
  copyText,
  activationFor,
}: {
  home: string;
  root: string | undefined;
  path: string;
  copyText: string;
  activationFor: (target: PathTarget) => Activation;
}) {
  const source = useHostPathSource(home, root);
  return (
    <PathBar
      path={path}
      source={source}
      activationFor={activationFor}
      // A side pane beside other surfaces: ⌘L stays the surface's own.
      shortcut={false}
      actions={
        <CopyButton
          text={copyText}
          aspect="inline"
          className="text-muted-foreground hover:text-foreground"
          tooltip="Copy path"
        />
      }
      // The whole title cell, so the trail measures the room the row gives it.
      className={fillClasses("x")}
    />
  );
}

/** The renderer tabs (Diff / Raw / Preview …) as a file-peek header item. */
export function FilePeekTabs() {
  const { renderers } = useFilePeekHeader();
  if (renderers === null) return null;
  return <FileTabs {...renderers} />;
}
