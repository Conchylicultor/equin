import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { FolderPicker, UNAVAILABLE_MESSAGE } from "./folder-picker";
import { hostFsListing } from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const cancelIcon = symbol("cancel");
const checkCircleIcon = symbol("check-circle");
const folderOpenIcon = symbol("folder-open");

type Verdict = { valid: true } | { valid: false; reason: string };

export type FolderPickerPopoverProps =
  | {
      /**
       * `edit` — the field HOLDS a folder (a config value): its path, a
       * validity mark, an icon-only browse button.
       */
      purpose: "edit";
      value: string;
      onChange: (value: string) => void;
      placeholder?: string;
    }
  | {
      /**
       * `add` — the field ADDS a folder to a list beside it: an empty dashed
       * field (the optional affordance) and a labelled "Browse…" button. A
       * typed path is handed over on Enter or blur, a browsed one on pick, and
       * the field empties itself again.
       */
      purpose: "add";
      onAdd: (path: string) => void;
      placeholder?: string;
    };

/**
 * A typeable/pasteable absolute-path input with a live validity indicator
 * (the path exists and is a directory) plus a "Browse" popover that walks the
 * host filesystem. Self-contained — no config_v2 dependency — so any surface
 * can pick a host folder.
 */
export function FolderPickerPopover(props: FolderPickerPopoverProps) {
  return props.purpose === "add" ? (
    <AddFolderField onAdd={props.onAdd} placeholder={props.placeholder} />
  ) : (
    <EditFolderField
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder}
    />
  );
}

function AddFolderField({
  onAdd,
  placeholder,
}: {
  onAdd: (path: string) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState("");
  const [open, setOpen] = useState(false);
  const add = (path: string) => {
    const trimmed = path.trim();
    setLocal("");
    if (trimmed.length > 0) onAdd(trimmed);
  };
  return (
    <Stack direction="row" gap="xs" align="center">
      <Fill>
        <Input
          outline="dashed"
          // A path is typed in the path face; the hint before it is prose.
          className="font-mono placeholder:font-sans"
          value={local}
          placeholder={placeholder ?? "Add a folder — type a path or browse"}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => add(local)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add(local);
          }}
        />
      </Fill>
      <InlinePopover
        resetOnClose
        open={open}
        onOpenChange={setOpen}
        align="end"
        width="xl"
        padding="none"
        trigger={
          <Button variant="secondary" shape="pill">
            Browse…
          </Button>
        }
      >
        <FolderPicker
          onSelect={(path) => {
            add(path);
            setOpen(false);
          }}
        />
      </InlinePopover>
    </Stack>
  );
}

function EditFolderField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  // `local` is seeded from `value` and re-initialized naturally on external
  // value changes by the caller remounting this component with `key={value}`
  // (the directory-path field renderer) — so no mirror effect is needed.
  const [local, setLocal] = useState(value);
  const [open, setOpen] = useState(false);

  const commit = (next: string) => {
    if (next !== value) onChange(next);
  };

  const hasValue = value.trim().length > 0;
  // The field holds an ABSOLUTE path: host-fs would also accept `~/…`, but
  // whoever reads the value need not expand it, so it is not offered as valid.
  const absolute = value.startsWith("/");
  // Whether the path is a folder host-fs can list: its listing's meta sibling
  // (the folder's own facts) is read, never its entries.
  const validity = useLive(
    hostFsListing.meta,
    hasValue && absolute ? { path: value } : null,
  );
  // Listable is valid, a refusal names why; not known yet, no computer behind
  // the app, or a failed read (which the browser below reports): no verdict.
  let listed: Verdict | undefined;
  switch (validity.status) {
    case "ready":
      listed = { valid: true };
      break;
    case "error":
      listed =
        validity.error.kind === "refused" && validity.error.code !== undefined
          ? { valid: false, reason: UNAVAILABLE_MESSAGE[validity.error.code] }
          : undefined;
      break;
    case "loading":
    case "unavailable":
      listed = undefined;
      break;
  }
  const verdict: Verdict | undefined = !hasValue
    ? undefined
    : !absolute
      ? { valid: false, reason: "Use an absolute path (starting with /)." }
      : listed;

  return (
    <Stack direction="row" gap="xs" align="center">
      <Fill className="relative">
        <Input
          value={local}
          placeholder={placeholder ?? "Absolute folder path"}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => commit(local)}
          className="pr-2xl"
        />
        {verdict ? (
          <Pin to="right" offset="sm" stretch decorative>
            <Center axis="vertical">
              {verdict.valid ? (
                <Icon
                  icon={checkCircleIcon}
                  className="size-4 text-success"
                  title="Folder exists"
                />
              ) : (
                <Icon
                  icon={cancelIcon}
                  className="size-4 text-destructive"
                  title={verdict.reason}
                />
              )}
            </Center>
          </Pin>
        ) : null}
      </Fill>

      <InlinePopover
        resetOnClose
        open={open}
        onOpenChange={setOpen}
        align="end"
        tooltip="Browse folders"
        width="xl"
        padding="none"
        trigger={<IconButton icon={folderOpenIcon} label="Browse folders" />}
      >
        <FolderPicker
          value={value}
          onSelect={(path) => {
            setLocal(path);
            commit(path);
            setOpen(false);
          }}
        />
      </InlinePopover>
    </Stack>
  );
}
