// The browser extension's shell framing the checkout's own app: main's into the
// installed data dir (Chrome loads it from there), a worktree's beside its
// build artifacts. Rewritten only when its digest moved; the backend's watch on
// the digest file tells every open popup to reload the extension onto it.
import { defineBuildStep } from "@plugins/framework/plugins/cli/plugins/build/plugins/build-steps/cli";
import { writeExtensionShell } from "../cli";

export default [
  defineBuildStep({
    id: "browserExtension",
    owner: "companions/browser-extension",
    label: "browser extension shell",
    phase: "deployed",
    run: async ({ root, namespace, log }) => {
      const shell = await writeExtensionShell({ root, namespace });
      log(
        `browser extension: ${shell.kind === "written" ? "wrote" : "unchanged"} ${shell.path} (${shell.digest.slice(0, 12)})`,
      );
    },
  }),
];
