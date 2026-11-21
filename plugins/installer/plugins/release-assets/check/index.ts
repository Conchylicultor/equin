import type { Check, RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { RELEASE_TAG_ERE } from "@plugins/upstream/plugins/release/core";
import {
  ATTACH_MARKER,
  HANDOFF_MARKER,
  INTERNAL_ARGS_MARKER,
  INSTALLER_BINARIES,
  INSTALLER_BINARY_PREFIX,
  RELEASE_FILES,
  RELEASE_WORKFLOW,
} from "../core";

/** install.sh: repo root (its URL is the documented entry point). */
const INSTALL_SCRIPT = "install.sh";

/**
 * The release workflow's step scripts: the workflow is a wrapper that runs
 * them (from its own commit's `.release-ci` checkout), so its logic changes
 * never edit a file under `.github/workflows/`.
 */
const SCRIPTS_DIR = "plugins/installer/plugins/release-assets/scripts";
/** The workflow's settings (WINDOW_ON_TAGS, RELEASE_TAG_ERE, CRATE). */
const RELEASE_CONFIG = `${SCRIPTS_DIR}/release-config.sh`;
/** Where every job of the workflow checks the scripts out. */
const CI_CHECKOUT = ".release-ci";

/** The workflow and its scripts, as one text: what the release pipeline spells. */
async function pipelineText(repo: RepoFiles): Promise<string | null> {
  const workflow = await repo.read(RELEASE_WORKFLOW);
  if (workflow === null) return null;
  const scripts = await Promise.all(
    repo
      .under(SCRIPTS_DIR)
      .filter((p) => p.endsWith(".sh"))
      .map((p) => repo.read(p)),
  );
  return [workflow, ...scripts.filter((t) => t !== null)].join("\n");
}

/** `<indent>RELEASE_TAG_ERE<sep>'<value>'` — release-config.sh's and install.sh's variable. */
function ereLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*RELEASE_TAG_ERE\s*[:=]\s*'([^']*)'\s*$/.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/**
 * The release tag grammar outside TypeScript — the workflow's tag filter (its
 * scripts' release-config.sh) and
 * stage 0's `--ref` validation — spelled exactly as RELEASE_TAG_ERE, the one
 * the CLI cuts tags with. A tag one side accepts and the other refuses would
 * be a release with no installer, or an install of something that is not one.
 */
const tagGrammar: Check = {
  id: "release-assets:tag-grammar",
  description:
    "The release workflow's (release-config.sh) and install.sh's release tag regex equal RELEASE_TAG_ERE (upstream/release)",
  async run(ctx) {
    const repo = await ctx.repo();
    const problems: string[] = [];
    for (const file of [RELEASE_CONFIG, INSTALL_SCRIPT]) {
      const text = await repo.read(file);
      if (text === null) {
        problems.push(`${file} is missing`);
        continue;
      }
      const found = ereLines(text);
      if (found.length !== 1)
        problems.push(
          `${file} must set RELEASE_TAG_ERE exactly once, single-quoted (found ${found.length})`,
        );
      else if (found[0] !== RELEASE_TAG_ERE)
        problems.push(
          `${file}: RELEASE_TAG_ERE is '${found[0]}', the grammar is '${RELEASE_TAG_ERE}'`,
        );
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n"),
      hint: `Copy RELEASE_TAG_ERE from plugins/upstream/plugins/release/core/internal/release-tag.ts, single-quoted.`,
    };
  },
};

/**
 * The names stage 0 downloads are the names the workflow publishes: every
 * installer binary named in the workflow, the installer sums file spelled by
 * both (the workflow uploads it last; stage 0 fetches it and derives each
 * binary's name as the prefix plus its platform key), and install.sh still
 * carrying the hand-off marker the workflow records in release.json.
 */
const assetNames: Check = {
  id: "release-assets:asset-names",
  description:
    "The release workflow builds every INSTALLER_BINARIES asset, it and install.sh spell the installer sums file, install.sh spells the binary prefix, and install.sh carries the hand-off and attach markers (every attach marker it spells the current one)",
  async run(ctx) {
    const repo = await ctx.repo();
    const problems: string[] = [];
    const workflow = await pipelineText(repo);
    const script = await repo.read(INSTALL_SCRIPT);
    if (workflow === null) problems.push(`${RELEASE_WORKFLOW} is missing`);
    else
      for (const [platform, name] of Object.entries(INSTALLER_BINARIES))
        if (!workflow.includes(platform) && !workflow.includes(name))
          problems.push(
            `${RELEASE_WORKFLOW} (with its scripts) builds no ${name} (${platform})`,
          );
    for (const [file, text] of [
      [RELEASE_WORKFLOW, workflow],
      [INSTALL_SCRIPT, script],
    ] as const)
      if (text !== null && !text.includes(RELEASE_FILES.installerSums))
        problems.push(
          `${file} never names ${RELEASE_FILES.installerSums}: the workflow attaches it last, and stage 0 verifies the window against it`,
        );
    if (script !== null && !script.includes(`${INSTALLER_BINARY_PREFIX}$key`))
      problems.push(
        `${INSTALL_SCRIPT} no longer spells '${INSTALLER_BINARY_PREFIX}$key': stage 0 names a v2 release's window binary as INSTALLER_BINARY_PREFIX plus its platform key`,
      );
    if (script === null) problems.push(`${INSTALL_SCRIPT} is missing`);
    else if (!script.split("\n").includes(HANDOFF_MARKER))
      problems.push(
        `${INSTALL_SCRIPT} has lost its '${HANDOFF_MARKER}' line: stage 0 would no longer hand any new release to its own script`,
      );
    if (script !== null && !script.split("\n").includes(INTERNAL_ARGS_MARKER))
      problems.push(
        `${INSTALL_SCRIPT} has lost its '${INTERNAL_ARGS_MARKER}' line: the install's internal arguments would go back on the command line a terminal shows in its title`,
      );
    if (script !== null) {
      if (!script.split("\n").includes(ATTACH_MARKER))
        problems.push(
          `${INSTALL_SCRIPT} has lost its '${ATTACH_MARKER}' line: no install could hand its steps after the clone to the checkout's own script, and stage 0 would refuse every release for --ref main`,
        );
      for (const m of script.matchAll(/# installer-attach: \d+/g))
        if (m[0] !== ATTACH_MARKER)
          problems.push(
            `${INSTALL_SCRIPT} spells '${m[0]}', but the install event protocol is '${ATTACH_MARKER}': its hand-over and stage 0 must test the marker it carries`,
          );
    }
    if (problems.length === 0) return { ok: true };
    return { ok: false, message: problems.join("\n") };
  },
};

/**
 * The workflow is a wrapper: every `run:` is one line running a script of
 * SCRIPTS_DIR (`bash "$SCRIPTS/<file>.sh" [args]`), every script it names
 * exists, and every job's `.release-ci` checkout and the SCRIPTS env point at
 * SCRIPTS_DIR. Release logic written inline would edit
 * `.github/workflows/` on each fix — and GitHub refuses such a push from a
 * token without the `workflow` scope, which is every clone pushing an
 * upstream merge to its own repo.
 */
const workflowIsWrapper: Check = {
  id: "release-assets:workflow-is-wrapper",
  description:
    "Every run step of the release workflow runs one of release-assets' scripts, which exist, from the .release-ci checkout of the workflow's own commit",
  async run(ctx) {
    const repo = await ctx.repo();
    const workflow = await repo.read(RELEASE_WORKFLOW);
    if (workflow === null)
      return { ok: false, message: `${RELEASE_WORKFLOW} is missing` };
    const problems: string[] = [];
    const lines = workflow.split("\n");
    const runStep = /^\s*(?:- )?run:\s*(.*)$/;
    const scriptRun =
      /^bash "\$SCRIPTS\/([A-Za-z0-9._-]+\.sh)"(?: [A-Za-z0-9_-]+)*$/;
    let runs = 0;
    lines.forEach((line, i) => {
      const m = runStep.exec(line);
      if (m === null) return;
      runs++;
      const body = (m[1] ?? "").trim();
      const script = scriptRun.exec(body);
      if (script?.[1] === undefined) {
        problems.push(
          `${RELEASE_WORKFLOW}:${i + 1}: \`run: ${body}\` — a run step must be one line, \`bash "$SCRIPTS/<file>.sh" [args]\`: move the logic into ${SCRIPTS_DIR}/`,
        );
        return;
      }
      if (!repo.has(`${SCRIPTS_DIR}/${script[1]}`))
        problems.push(
          `${RELEASE_WORKFLOW}:${i + 1}: runs ${script[1]}, which ${SCRIPTS_DIR}/ does not have`,
        );
    });
    if (runs === 0) problems.push(`${RELEASE_WORKFLOW} has no run step`);
    const env = /^\s*SCRIPTS:\s*(\S+)\s*$/m.exec(workflow)?.[1];
    if (env !== `${CI_CHECKOUT}/${SCRIPTS_DIR}`)
      problems.push(
        `${RELEASE_WORKFLOW}: the SCRIPTS env is '${env ?? "(unset)"}', must be '${CI_CHECKOUT}/${SCRIPTS_DIR}'`,
      );
    for (const m of workflow.matchAll(/^\s*sparse-checkout:\s*(\S+)\s*$/gm))
      if (m[1] !== SCRIPTS_DIR)
        problems.push(
          `${RELEASE_WORKFLOW}: a sparse checkout of '${m[1]}', must be '${SCRIPTS_DIR}'`,
        );
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n"),
      hint: "Release logic lives in the scripts; the workflow changes only for triggers, the job graph, runners and permissions (plugins/installer/plugins/release-assets/CLAUDE.md).",
    };
  },
};

export default [tagGrammar, assetNames, workflowIsWrapper];
