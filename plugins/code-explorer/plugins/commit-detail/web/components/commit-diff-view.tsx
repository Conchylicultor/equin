import { useState } from "react";
import {
  CollapsibleChevron,
  FoldMotion,
} from "@plugins/primitives/plugins/collapsible/web";
import { DiffOrImageView } from "@plugins/primitives/plugins/diff-view/web";
import type { EditedFile } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { commitFiles } from "@plugins/code-explorer/plugins/code-api/core";

export function CommitDiffView({
  worktree,
  sha,
}: {
  worktree: string;
  sha: string;
}) {
  const result = useLive(commitFiles, { worktree, sha });

  if (result.status === "loading") {
    return <Loading />;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the commit's files"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  const { files, baseSha, headSha } = result.data;
  return (
    <CommitFileList
      files={files}
      worktree={worktree}
      baseSha={baseSha}
      headSha={headSha}
    />
  );
}

function CommitFileList({
  files,
  worktree,
  baseSha,
  headSha,
}: {
  files: EditedFile[];
  worktree: string;
  baseSha: string;
  headSha: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (files.length === 0) {
    return <Placeholder>No changes in this commit.</Placeholder>;
  }

  const totals = files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <Column
      fill
      className="h-full"
      header={
        <Stack
          direction="row"
          gap="md"
          align="center"
          className="border-b border-border bg-background/95 px-lg py-sm backdrop-blur"
        >
          <Text as="span" variant="label" className="tabular-nums">
            {files.length} {files.length === 1 ? "file" : "files"}
          </Text>
          <Text
            as="span"
            variant="caption"
            className="tabular-nums text-success"
          >
            +{totals.additions}
          </Text>
          <Text
            as="span"
            variant="caption"
            className="tabular-nums text-destructive"
          >
            −{totals.deletions}
          </Text>
        </Stack>
      }
      body={files.map((file) => (
        <CommitFileRow
          key={file.path}
          file={file}
          worktree={worktree}
          baseSha={baseSha}
          headSha={headSha}
          expanded={expanded.has(file.path)}
          onToggle={() => toggle(file.path)}
        />
      ))}
    />
  );
}

function CommitFileRow({
  file,
  worktree,
  baseSha,
  headSha,
  expanded,
  onToggle,
}: {
  file: EditedFile;
  worktree: string;
  baseSha: string;
  headSha: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const basename = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const from = file.from && file.from !== file.path ? file.from : null;

  return (
    <div className="border-b border-border last:border-b-0">
      <Sticky>
        <button
          type="button"
          onClick={onToggle}
          className="text-body w-full bg-muted px-md py-xs text-left hover:bg-muted/80"
          aria-expanded={expanded}
        >
          <Line className="w-full gap-sm">
            <CollapsibleChevron
              open={expanded}
              className={cn("size-4 text-muted-foreground", rigidClass())}
            />
            <Fill as="span">
              <Text as="span">
                {from && (
                  <>
                    <span className="text-muted-foreground line-through">
                      {from}
                    </span>
                    {/* eslint-disable-next-line spacing/no-adhoc-spacing -- inline horizontal offset around the rename arrow between two file paths */}
                    <span className="mx-1.5 text-muted-foreground">→</span>
                  </>
                )}
                <span className="text-muted-foreground">{dir}</span>
                <span className="font-medium">{basename}</span>
              </Text>
            </Fill>
            <Text
              as="span"
              variant="caption"
              className={cn(rigidClass(), "tabular-nums")}
            >
              <Stack as="span" direction="row" gap="sm" align="center">
                <span className="text-success">+{file.additions}</span>
                <span className="text-destructive">−{file.deletions}</span>
              </Stack>
            </Text>
          </Line>
        </button>
      </Sticky>
      <FoldMotion open={expanded}>
        <div className="bg-background">
          <DiffOrImageView
            worktree={worktree}
            path={file.path}
            base={baseSha}
            head={headSha}
            from={file.from}
          />
        </div>
      </FoldMotion>
    </div>
  );
}
