import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { formatStatusLabel } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  memoryFile,
  memoryFiles,
  type MemoryFile,
} from "../../shared/resources";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const MEMORY_FILES_VIEW = defineDataView("debug.memory");

function displayName(name: string): string {
  return formatStatusLabel(name.replace(/\.md$/, ""));
}

const NO_FILES: MemoryFile[] = [];

// The option order is the group order: the index first, `other` last.
const fields: FieldDef<MemoryFile>[] = [
  {
    id: "name",
    label: "File",
    type: "text",
    primary: true,
    value: (f) => displayName(f.name),
    sortable: true,
    filterable: false,
  },
  {
    id: "type",
    label: "Type",
    type: "enum",
    options: [
      { value: "index", label: "Index", variant: "muted" },
      { value: "feedback", label: "Feedback", variant: "warning" },
      { value: "project", label: "Project", variant: "info" },
      { value: "user", label: "User", variant: "success" },
      { value: "reference", label: "Reference", variant: "primary" },
      { value: "other", label: "Other", variant: "muted" },
    ],
    value: (f) => f.type,
    sortable: true,
    filterable: true,
  },
];

export function MemoryPanel() {
  // The user's explicit pick (null until they click a file). The effective
  // selection derives the first file as a default in render — no effect — and
  // falls back to it when the picked file leaves the folder.
  const [picked, setPicked] = useState<string | null>(null);

  // Live: the memory folder's watch pushes every file added or removed.
  const list = useLive(memoryFiles);
  // The DataView renders the loading and failed states (`readiness`); only a
  // ready listing's rows reach the view.
  const files = foldResource(list, {
    loading: () => NO_FILES,
    error: () => NO_FILES,
    ready: (d) => d.files,
  });
  const selected =
    picked !== null && files.some((f) => f.name === picked)
      ? picked
      : (files[0]?.name ?? null);

  return (
    <Stack direction="row" gap="none" className="h-full">
      {/* File list */}
      <Stack gap="none" className={cn("w-56 border-r", rigidClass())}>
        <Stack
          direction="row"
          gap="none"
          align="center"
          className="border-b px-md py-sm"
        >
          <SectionLabel as="span" className="font-medium">
            Memory files
          </SectionLabel>
        </Stack>
        <Scroll fill className="py-xs">
          <DataView<MemoryFile>
            storageKey={MEMORY_FILES_VIEW}
            rows={files}
            readiness={list}
            rowKey={(f) => f.name}
            searchAccessor={(f) => f.name}
            fields={fields}
            views={["list"]}
            density="compact"
            selectedRowId={selected ?? undefined}
            onRowActivate={(f) => setPicked(f.name)}
            emptyState="No memory files found."
          />
        </Scroll>
        {list.status === "ready" && (
          <div className="border-t px-md py-sm">
            <p
              className="truncate font-mono text-3xs text-muted-foreground/50"
              title={list.data.dir}
            >
              {list.data.dir}
            </p>
          </div>
        )}
      </Stack>

      {/* Content */}
      <Scroll fill>
        <MemoryContent listStatus={list.status} selected={selected} />
      </Scroll>
    </Stack>
  );
}

/**
 * The right pane: nothing to pick from until the listing lands (its own
 * loading and error states are the list's), then the selected file.
 */
function MemoryContent({
  listStatus,
  selected,
}: {
  listStatus: "loading" | "error" | "ready";
  selected: string | null;
}) {
  if (listStatus === "loading") {
    return (
      <Center className="h-full">
        <Loading />
      </Center>
    );
  }
  if (listStatus === "error") return null;
  if (selected === null) {
    return (
      <Center className="h-full">
        <Text as="div" variant="body" className="text-muted-foreground">
          Select a memory file
        </Text>
      </Center>
    );
  }
  return <MemoryFileContent name={selected} />;
}

/** One file's markdown — live: an edit re-renders it, a delete refuses it. */
function MemoryFileContent({ name }: { name: string }) {
  const content = useLive(memoryFile, { name });
  switch (content.status) {
    case "loading":
      return (
        <Center className="h-full">
          <Loading />
        </Center>
      );
    case "error":
      return (
        <Center className="h-full">
          <ResourceErrorInline
            variant="block"
            subject={name}
            error={content.error}
            refetch={content.refetch}
          />
        </Center>
      );
    case "ready":
      return (
        <Text as="div" variant="body" className="px-xl py-lg">
          <Markdown>{content.data.content}</Markdown>
        </Text>
      );
  }
}
