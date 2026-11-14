import { useCallback } from "react";
import { CompanionPanel } from "@plugins/companions/plugins/panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { BrowserExtension } from "../slots";
import { useExtensionHost, type ExtensionHost } from "../host";
import { RecordOpen, ShellUpdate } from "../internal/shell-update";
import { NeedsExtension } from "./needs-extension";

/**
 * The extension's panel: the page its popup frames
 * (`/home/browser-extension?embed=1`), the WHOLE browser-extension app — the
 * companions' panel over `BrowserExtension.Section`, plus what only the
 * extension does: the popup following the content's height, recording each open, and reloading the
 * extension onto a newer shell. Opened in a plain tab, it says it runs inside
 * the extension.
 */
export function BrowserExtensionPanel() {
  const host = useExtensionHost();
  if (host.kind === "pending")
    return <Loading variant="block" className="size-full" />;
  if (host.kind === "absent") return <NeedsExtension />;
  return <PresentPanel host={host} />;
}

function PresentPanel({
  host,
}: {
  host: Extract<ExtensionHost, { kind: "present" }>;
}) {
  const { setHeight, reload } = host;
  const onContentHeight = useCallback(
    (px: number) => void setHeight(px),
    [setHeight],
  );
  return (
    <CompanionPanel
      sections={BrowserExtension.Section}
      onContentHeight={onContentHeight}
    >
      <ShellUpdate shellDigest={host.info.shellDigest} reload={reload} />
      <RecordOpen shellDigest={host.info.shellDigest} />
    </CompanionPanel>
  );
}
