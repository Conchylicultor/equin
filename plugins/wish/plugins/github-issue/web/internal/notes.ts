import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";
import type { IssueCode, IssueEnvironment } from "../../core";

/** The backend's half of the environment as the button read it. */
export type EnvironmentRead =
  | { kind: "ready"; environment: IssueEnvironment }
  /** No computer behind this page (an in-browser server): `message` says so. */
  | { kind: "unavailable"; message: string }
  /** The read failed; the issue says so rather than leaving the lines out. */
  | { kind: "error"; message: string };

/** How many characters of a commit sha an issue names — what `git log --oneline` shows. */
const SHORT_SHA = 10;

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** `2026.11.17.2 · bf902af7e2 · 3 commits ahead of upstream/main, 12 behind`. */
export function versionLine(code: IssueCode): string {
  if (code.kind === "unknown") return `unknown commit (${code.reason})`;
  const release =
    code.release === null ? "no release" : releaseVersion(code.release);
  const standing =
    code.ahead === 0 && code.behind === 0
      ? `at ${code.base}`
      : code.ahead === 0
        ? `${commits(code.behind)} behind ${code.base}`
        : code.behind === 0
          ? `${commits(code.ahead)} ahead of ${code.base}`
          : `${commits(code.ahead)} ahead of ${code.base}, ${code.behind} behind`;
  return `${release} · ${code.commit.slice(0, SHORT_SHA)} · ${standing}`;
}

/**
 * The issue's closing lines about where it was filed from: the version of the
 * code (release, commit, local changes against the trunk), the machine, and
 * the browser — what a maintainer asks first.
 */
export function environmentNotes(
  read: EnvironmentRead,
  browser: string,
): string[] {
  const browserLine = `Browser: ${browser}`;
  switch (read.kind) {
    case "ready":
      return [
        `Version: ${PRODUCT_NAME} ${versionLine(read.environment.code)}`,
        `System: ${read.environment.system} · ${read.environment.runtime}`,
        browserLine,
      ];
    case "unavailable":
      return [`Version: ${read.message}`, browserLine];
    case "error":
      return [`Version: could not be read (${read.message})`, browserLine];
  }
}
