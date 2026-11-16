import { useMemo, type ReactNode } from "react";
import { DiffOrImageView } from "@plugins/primitives/plugins/diff-view/web";
import type { EditedFile } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";
import {
  DataView,
  defineDataView,
  useDataViewControls,
  useFlatRows,
  type DataViewSection,
  type FieldDef,
  type FieldOption,
} from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  COMMIT_FILES_MAX,
  commitFiles,
} from "@plugins/code-explorer/plugins/code-api/core";
import {
  FILE_KIND_IDS,
  FILE_KINDS,
  fileKindOf,
  type FileKind,
} from "@plugins/code-explorer/plugins/file-kind/core";
import {
  asPath,
  pluginIdOfRepoPath,
} from "@plugins/framework/plugins/plugin-id/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

// Marker scraped by codegen (data-views.generated.ts). Its views — All files
// (home), Code, Tests, Docs: each a filter on `kind` — are authored in
// config/code-explorer/commit-detail/commit-files.jsonc.
const COMMIT_FILES_VIEW = defineDataView("commit-files");

/** The always-first view (`viewEdits.home`), authored in the config. */
const HOME_VIEW_ID = "all";

const pluginIcon = symbol("extension");
const folderIcon = symbol("folder");

/** One changed file of the commit, with what the list groups and sorts by. */
interface CommitFileRow extends EditedFile {
  kind: FileKind;
  /**
   * What the file is grouped under by plugin: the plugin's path form
   * (`code-explorer/commit-detail`), or the top-level directory of a path
   * outside `plugins/` (`gateway`, `.` for a root file).
   */
  plugin: string;
  /** Whether {@link plugin} names a plugin (else a top-level directory). */
  inPlugin: boolean;
  /** The file's directory (`.` for a root file). */
  folder: string;
  /** additions + deletions — "most changed". */
  churn: number;
}

function toRow(file: EditedFile): CommitFileRow {
  const id = pluginIdOfRepoPath(file.path);
  const slash = file.path.lastIndexOf("/");
  const firstSlash = file.path.indexOf("/");
  return {
    ...file,
    kind: fileKindOf(file.path),
    plugin:
      id !== null
        ? asPath(id)
        : firstSlash >= 0
          ? file.path.slice(0, firstSlash)
          : ".",
    inPlugin: id !== null,
    folder: slash >= 0 ? file.path.slice(0, slash) : ".",
    churn: file.additions + file.deletions,
  };
}

const NO_ROWS: CommitFileRow[] = [];

const KIND_OPTIONS: FieldOption[] = FILE_KIND_IDS.map((id) => ({
  value: id,
  label: FILE_KINDS[id].pluralLabel,
  icon: FILE_KINDS[id].icon,
}));

export function CommitDiffView({
  worktree,
  sha,
}: {
  worktree: string;
  sha: string;
}) {
  const result = useLive(commitFiles, { worktree, sha });
  const data = foldResource(result, {
    loading: () => null,
    unavailable: () => null,
    error: () => null,
    ready: (d) => d,
  });
  const rows = useMemo(
    () => (data === null ? NO_ROWS : data.files.map(toRow)),
    [data],
  );
  const truncated = data?.truncated === true;
  const baseSha = data?.baseSha ?? "";
  const headSha = data?.headSha ?? "";

  // The plugin field's options are the groups this commit has — so a group
  // header carries a plugin's (or a top-level directory's) glyph, and the
  // filter offers exactly the plugins the commit touches.
  const pluginOptions = useMemo<FieldOption[]>(() => {
    const seen = new Map<string, boolean>();
    for (const r of rows) seen.set(r.plugin, r.inPlugin);
    return [...seen]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, inPlugin]) => ({
        value,
        label: value,
        icon: inPlugin ? pluginIcon : folderIcon,
      }));
  }, [rows]);

  const fields = useMemo<FieldDef<CommitFileRow>[]>(
    () => [
      {
        id: "path",
        label: "Path",
        type: "text",
        primary: true,
        value: (r) => r.path,
        cell: (r) => <FilePath row={r} />,
        sortable: true,
      },
      {
        id: "kind",
        label: "Kind",
        type: "enum",
        value: (r) => r.kind,
        options: KIND_OPTIONS,
        filterable: true,
        sortable: true,
      },
      {
        // The kind named beside the title for every file that is not code —
        // the glyph alone is easy to miss in a list of mostly code.
        id: "kindTag",
        label: "Kind tag",
        cell: (r) =>
          r.kind === "code" ? null : (
            <Badge variant="muted">
              {FILE_KINDS[r.kind].label.toLowerCase()}
            </Badge>
          ),
        sortable: false,
        filterable: false,
      },
      {
        id: "plugin",
        label: "Plugin",
        type: "enum",
        value: (r) => r.plugin,
        options: pluginOptions,
        filterable: true,
        sortable: true,
        visible: false,
      },
      {
        id: "folder",
        label: "Folder",
        type: "text",
        value: (r) => r.folder,
        groupable: true,
        sortable: true,
        visible: false,
      },
      {
        id: "additions",
        label: "Additions",
        type: "number",
        value: (r) => r.additions,
        cell: (r) => <Count sign="+" n={r.additions} tone="add" />,
        sortable: true,
      },
      {
        id: "deletions",
        label: "Deletions",
        type: "number",
        value: (r) => r.deletions,
        cell: (r) => <Count sign="−" n={r.deletions} tone="del" />,
        sortable: true,
      },
      {
        id: "churn",
        label: "Lines changed",
        type: "number",
        value: (r) => r.churn,
        sortable: true,
        visible: false,
      },
    ],
    [pluginOptions],
  );

  const viewOptions = useMemo(
    () => ({
      list: {
        detail: (r: CommitFileRow) => (
          <DiffOrImageView
            worktree={worktree}
            path={r.path}
            base={baseSha}
            head={headSha}
            from={r.from}
          />
        ),
        detailOnActivate: true,
      },
    }),
    [worktree, baseSha, headSha],
  );

  return (
    <DataView<CommitFileRow>
      rows={rows}
      readiness={result}
      fields={fields}
      rowKey={rowKeyOf}
      storageKey={COMMIT_FILES_VIEW}
      views={["list"]}
      viewOptions={viewOptions}
      viewEdits={{ mode: "draft", home: HOME_VIEW_ID }}
      promotedSettings={PROMOTED_SETTINGS}
      place={PLACE}
      sectionSummary={sectionSummary}
      revealHidden
      searchAccessor={searchText}
      searchPlaceholder="Search files"
      actions={<VisibleTotals />}
      notice={
        truncated ? (
          <Text variant="caption" tone="muted" className="rail-follow py-xs">
            Showing the first {COMMIT_FILES_MAX} files.
          </Text>
        ) : undefined
      }
      emptyState={<>No changes in this commit.</>}
    />
  );
}

const PROMOTED_SETTINGS = ["data-view.group-by"] as const;

const PLACE = { kindTag: "afterTitle" } as const;

function rowKeyOf(r: CommitFileRow): string {
  return r.path;
}

function searchText(r: CommitFileRow): string {
  return r.from ? `${r.path} ${r.from}` : r.path;
}

function sumOf(rows: readonly CommitFileRow[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const r of rows) {
    add += r.additions;
    del += r.deletions;
  }
  return { add, del };
}

/** A group header's `+a −d`, at rest. */
function sectionSummary(section: DataViewSection<unknown>): ReactNode {
  const { add, del } = sumOf(
    section.entries.map((e) => e.row as CommitFileRow),
  );
  return <Stat add={add} del={del} />;
}

/**
 * What the active view shows, in the toolbar: `23 of 29 +381 −96` — the
 * files passing the view's filter and the search, of the commit's files,
 * with their summed lines. Reads the view's own rows and state
 * (`useDataViewControls`), so it agrees with what is drawn.
 */
function VisibleTotals(): ReactNode {
  const { rows, fields, activeState, filter } = useDataViewControls();
  const all = (rows ?? NO_ROWS) as readonly CommitFileRow[];
  const visible = useFlatRows(
    all,
    fields as FieldDef<CommitFileRow>[],
    activeState,
    filter.resolveOperatorSet,
    searchText,
  );
  if (rows === null) return null;
  const { add, del } = sumOf(visible);
  return (
    <Inline gap="sm" align="center">
      <Text as="span" variant="label" className="tabular-nums">
        {visible.length}
        {visible.length !== all.length && (
          <span className="font-normal text-muted-foreground">
            {" "}
            of {all.length}
          </span>
        )}
      </Text>
      <Stat add={add} del={del} />
    </Inline>
  );
}

function Stat({ add, del }: { add: number; del: number }): ReactNode {
  return (
    <Inline gap="sm" align="center">
      <Count sign="+" n={add} tone="add" />
      <Count sign="−" n={del} tone="del" />
    </Inline>
  );
}

function Count({
  sign,
  n,
  tone,
}: {
  sign: "+" | "−";
  n: number;
  tone: "add" | "del";
}): ReactNode {
  return (
    <Text
      as="span"
      variant="caption"
      className={cn(
        "font-mono tabular-nums",
        n === 0
          ? "text-muted-foreground"
          : tone === "add"
            ? "text-success"
            : "text-destructive",
      )}
    >
      {sign}
      {n}
    </Text>
  );
}

/**
 * The path as the row's title: the directory muted, the basename strong, a
 * rename's old path struck through before it.
 */
function FilePath({ row }: { row: CommitFileRow }): ReactNode {
  const slash = row.path.lastIndexOf("/");
  const dir = slash >= 0 ? row.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? row.path.slice(slash + 1) : row.path;
  const from = row.from && row.from !== row.path ? row.from : null;
  return (
    <>
      {from && (
        <>
          <span className="text-muted-foreground line-through">{from}</span>
          <span className="text-muted-foreground">{" → "}</span>
        </>
      )}
      <span className="font-normal text-muted-foreground">{dir}</span>
      <span>{base}</span>
    </>
  );
}
