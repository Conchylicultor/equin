import { useLive } from "@plugins/network/plugins/live/web";
import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { issueEnvironment } from "../../core";
import { describeBrowser } from "./browser";
import { environmentNotes, type EnvironmentRead } from "./notes";

const readUserAgent = () => navigator.userAgent;

/**
 * The issue's environment lines (version, system, browser), or `loading` while
 * the backend's half has not arrived — never lines missing what is about to
 * land.
 */
export function useEnvironmentNotes():
  { kind: "loading" } | { kind: "ready"; notes: string[] } {
  const read = useLive(issueEnvironment);
  const userAgent = useBrowserValue({
    name: "navigator.userAgent",
    read: readUserAgent,
  });
  let env: EnvironmentRead;
  switch (read.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      env = { kind: "ready", environment: read.data };
      break;
    case "unavailable":
      env = { kind: "unavailable", message: read.message };
      break;
    case "error":
      env = { kind: "error", message: read.error.message };
      break;
  }
  return {
    kind: "ready",
    notes: environmentNotes(env, describeBrowser(userAgent)),
  };
}
