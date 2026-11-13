// The build step that writes the extension shell framing a namespace (main's
// into the installed data dir). No default export: shared CLI machinery that
// `./equin build` runs, not a command declaration.
export { writeExtensionShell, type ShellWrite } from "./internal/write-shell";
