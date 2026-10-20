import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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

export interface FolderPickerPopoverProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * A typeable/pasteable absolute-path input with a live validity indicator
 * (the path exists and is a directory) plus a "Browse" popover that walks the
 * host filesystem. Self-contained — no config_v2 dependency — so any surface
 * can pick a host folder.
 */
export function FolderPickerPopover({
  value,
  onChange,
  placeholder,
}: FolderPickerPopoverProps) {
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
