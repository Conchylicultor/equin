import { useMemo, useState, type ReactNode } from "react";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  fileStatOf,
  type BrowsableFileSystem,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import {
  FileContent,
  FileHeaderActions,
  FileTabs,
  useFileRenderers,
  useArchiveMembership,
  useOpenHostFile,
} from "@plugins/primitives/plugins/file-viewer/web";
import type { FileViewerGit } from "@plugins/primitives/plugins/file-viewer/core";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { filesDocumentTheme } from "../internal/theme";
import { baseName, formatModified, formatSize, parentPath } from "../../core";

const closeIcon = symbol("close");

/**
 * The file open beside the listing: a header naming it (`parent · size ·
 * modified`) with Open with default app (on the computer's disk) and Close,
 * over the file viewer's best
 * renderer for it. The renderer tabs show only when there is a choice — a
 * changed file in a git checkout (`git`, from a lens) also offers its diff.
 */
export function PreviewPane({
  fs = "computer",
  path,
  name: displayName,
  home,
  git,
  onClose,
  closeLabel = "Close (Esc)",
  endSafeArea,
}: {
  /** The file system holding it. Default the computer's disk. */
  fs?: BrowsableFileSystem;
  /** The file, in display form (`~/…`). */
  path: string;
  /**
   * What to call the file, when that is not its name on disk — an attachment is
   * stored as `<uuid>.pdf` but is the `report.pdf` the user attached.
   */
  name?: string;
  /** What `~` is in `fs`. */
  home: string;
  /** The file's git context, when a lens knows it. */
  git: FileViewerGit | undefined;
  /** Omitted where there is nothing to close to (the pane is the route's root). */
  onClose?: () => void;
  /** The Close button's name — it states the host's own shortcut, if any. */
  closeLabel?: string;
  /** The header sits at the surface's top-right corner (floating action bar). */
  endSafeArea: boolean;
}): ReactNode {
  const file = useMemo(() => ({ fs, path }), [fs, path]);
  const renderers = useFileRenderers({
    file,
    ...(git !== undefined ? { git } : {}),
  });
  const openHostFile = useOpenHostFile();
  const membership = useArchiveMembership(file);
  const name = displayName ?? baseName(path);
  return (
    <Column
      fill
      className="h-full"
      scrollBody={false}
      // The Files layout hides its sidebar beside an open file on a narrow
      // window, keyed on this mark.
      data-files-preview=""
      header={
        <Bar
          tier="pane"
          endSafeArea={endSafeArea}
          // The mockup's header: 16px in from the pane's edge, 10px between
          // its parts.
          className="gap-smd pl-lg"
        >
          {/* The mockup's 20px icon box holding a 14px glyph: the Seti
              glyphs are cropped to fill their box, so the box alone would
              draw them half again too large. */}
          <Center className={cn(rigidClass(), "size-5")}>
            <FileTypeIcon name={name} className="size-3.5" />
          </Center>
          <Fill>
            <Stack gap="none">
              <Text
                variant="label"
                className="truncate font-semibold text-foreground"
              >
                {name}
              </Text>
              <PreviewMeta fs={fs} path={path} home={home} />
            </Stack>
          </Fill>
          <FileHeaderActions attach={renderers.header.attach} />
          {renderers.resolved.length > 1 && <FileTabs {...renderers} />}
          {/* Only the computer's disk hands a file to its apps. No button for
              an archive member (nothing on disk to open) or when there is no
              telling; pending until the stat lands. */}
          {fs === "computer" &&
            (membership.kind === "loading" ||
              (membership.kind === "known" && !membership.inArchive)) && (
            <IconButton
              icon={navIcons.hostApp}
              label="Open with default app"
              variant="ghost"
              disabled={membership.kind === "loading"}
              onClick={() => openHostFile(path)}
            />
          )}
          {onClose && (
            <IconButton
              icon={closeIcon}
              label={closeLabel}
              variant="ghost"
              onClick={onClose}
            />
          )}
        </Bar>
      }
      body={
        <Scroll axis="both" className="h-full">
          <Theme
            name={subThemeScope(filesDocumentTheme)}
            surface="none"
            // The code renderer is its own scroll box, sized to this height.
            className="h-full"
          >
            <FileContent file={file} renderers={renderers} />
          </Theme>
        </Scroll>
      }
    />
  );
}

/**
 * `parent · size · modified`, from the file's own stat (its system's `stat`,
 * pushed while read, so an edit on disk moves them). Only the parent until
 * the stat answers; a refusal says why in its place.
 */
function PreviewMeta({
  fs,
  path,
  home,
}: {
  fs: BrowsableFileSystem;
  path: string;
  home: string;
}): ReactNode {
  const stat = useLive(fileStatOf(fs), { path });
  const [now] = useState(() => Date.now());
  const parent = parentPath(path, home) ?? "/";
  const parts = [parent];
  if (stat.status === "ready") {
    parts.push(
      formatSize(stat.data.entry.size),
      formatModified(stat.data.entry.mtimeMs, now),
    );
  } else if (stat.status === "error") {
    switch (stat.error.code) {
      case "missing":
        parts.push("no longer exists");
        break;
      case "denied":
        parts.push("permission denied");
        break;
      case "unsupported":
      case "invalid-path":
        parts.push(stat.error.message);
        break;
      case undefined:
        // A read that failed (not a refusal): said, with its Retry, below.
        break;
    }
  }
  const failed =
    stat.status === "error" && stat.error.kind !== "refused" ? stat : null;
  return (
    // The small caption rung (`2xs`), faint.
    <ControlSizeProvider size="xs">
      <Text variant="caption" tone="faint" className="truncate">
        {parts.join(" · ")}
      </Text>
      {failed !== null && (
        <ResourceErrorInline
          variant="inline"
          error={failed.error}
          refetch={failed.refetch}
          subject="its size"
        />
      )}
    </ControlSizeProvider>
  );
}
