import { useEffect } from "react";
import { z } from "zod";
import { useLive } from "@plugins/network/plugins/live/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import { browserExtensionShell, recordExtensionOpen } from "../../core";

/** The last update this page asked the extension for (`<own>→<served>`). */
const reloadAttemptStore = defineStore({
  owner: "browser-extension.reload-attempt",
  pageWide: { reason: "the extension shell the popup page runs in" },
  label: "Browser extension update attempt",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.string(),
});

/**
 * Keeps the installed shell current, push-based: the served shell's digest is
 * a live value the build's rewrite notifies, and when it differs from the
 * shell's own the page asks the extension to reload — Chrome re-reads an
 * unpacked extension from disk and closes the popup, so the next open runs the
 * new shell. Asked once per (own, served) pair: a shell loaded from another
 * folder cannot be updated by reloading, and asking again would close the
 * popup on every open (Settings shows it as an update pending).
 */
export function ShellUpdate({
  shellDigest,
  reload,
}: {
  shellDigest: string;
  reload: () => Promise<void>;
}) {
  const shell = useLive(browserExtensionShell);
  const served =
    shell.status === "ready" && shell.data.kind === "built"
      ? shell.data.digest
      : null;
  useEffect(() => {
    if (served === null || served === shellDigest) return;
    const attempt = `${shellDigest}→${served}`;
    const last = reloadAttemptStore.read("");
    if (last.kind === "value" && last.value === attempt) return;
    reloadAttemptStore.write("", attempt);
    clientLog(
      "browser-extension",
      `shell ${shellDigest.slice(0, 12)} is not the served ${served.slice(0, 12)}; reloading the extension`,
    );
    void reload();
  }, [served, shellDigest, reload]);
  return null;
}

/** Records that the popup opened (and on which shell), for Settings. */
export function RecordOpen({ shellDigest }: { shellDigest: string }) {
  const fetchEndpoint = useFetchEndpoint();
  useEffect(() => {
    // eslint-disable-next-line endpoints/no-void-fetch-endpoint -- a silent record for Settings: a lost one is redone by the next open, and the popup shows no toasts
    void fetchEndpoint(recordExtensionOpen, {}, { body: { shellDigest } });
  }, [fetchEndpoint, shellDigest]);
  return null;
}
