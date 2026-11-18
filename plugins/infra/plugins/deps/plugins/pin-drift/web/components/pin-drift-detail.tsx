import { ResourceView } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { pinDrift, pinSwitchCommand, type PinnedDepRow } from "../../core";
import { installLabel } from "../internal/pin-health";

// The Pinned binaries row's expanded detail: per pinned dependency, what is
// pinned against what main declares, and the one thing to do about it — the
// command that switches the pin (with when it applies), or why the move is
// blocked. Mounted only while the row is expanded.
//
// Not a DataView: the pinned dependencies are a closed handful (the host
// daemons' binaries), shown as a paragraph each, nothing to sort or filter.

function Command({ command }: { command: string }) {
  return (
    <Inline gap="2xs">
      <Text variant="caption" tone="strong" className="font-mono">
        {command}
      </Text>
      <CopyButton text={command} tooltip="Copy the command" aspect="inline" />
    </Inline>
  );
}

function PinnedDep({ row, mainRoot }: { row: PinnedDepRow; mainRoot: string }) {
  const s = row.status;
  if (s.kind === "unpinned") {
    return (
      <Text variant="caption" tone="muted">
        Not pinned yet: the next start pins what main declares.
      </Text>
    );
  }
  const pinned = installLabel(s.pinned);
  const running =
    s.running === null ? null : (
      <Text variant="caption" tone="muted">
        The running daemon still runs {installLabel(s.running)} until{" "}
        {row.appliesAt}.
      </Text>
    );
  switch (s.declared.kind) {
    case "same":
      return (
        <Stack gap="2xs">
          <Text variant="caption" tone="muted">
            Pinned {pinned}, as main declares.
          </Text>
          {running}
        </Stack>
      );
    case "failed":
      return (
        <Stack gap="2xs">
          <Text variant="caption" tone="muted">
            Pinned {pinned}. Couldn't read what main declares:{" "}
            {s.declared.message}
          </Text>
          {running}
        </Stack>
      );
    case "differs": {
      const to = installLabel(s.declared.install);
      return (
        <Stack gap="2xs">
          <Text variant="caption" tone="muted">
            Pinned {pinned}, main declares {to}.
          </Text>
          {s.declared.blocked === null ? (
            <>
              <Text variant="caption" tone="muted">
                Switch it (nothing restarts; it applies at {row.appliesAt}):
              </Text>
              <Command command={pinSwitchCommand(mainRoot, row.id)} />
            </>
          ) : (
            <Text variant="caption" tone="destructive">
              Not a plain switch: {s.declared.blocked}.
            </Text>
          )}
          {running}
        </Stack>
      );
    }
  }
}

export function PinDriftDetail() {
  // The row's summary already says why when the value is not `checked`.
  return (
    <ResourceView resource={useLive(pinDrift)}>
      {(drift) =>
        drift.kind === "checked" ? (
          <Stack gap="sm">
            {drift.rows.map((row) => (
              <Stack key={row.id} gap="2xs">
                <Text variant="label">{row.id}</Text>
                <PinnedDep row={row} mainRoot={drift.mainRoot} />
              </Stack>
            ))}
          </Stack>
        ) : null
      }
    </ResourceView>
  );
}
