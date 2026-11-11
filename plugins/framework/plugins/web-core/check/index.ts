import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  alwaysRun?: boolean;
  run(): Promise<CheckResult>;
};

const INDEX_HTML = "plugins/framework/plugins/web-core/web/index.html";

async function readShell(): Promise<string> {
  const root = await getWorktreeRoot();
  return readFileSync(join(root, INDEX_HTML), "utf8");
}

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * Two things splice into the shell before its FIRST `</head>`: the build's
 * compose (the import map, CSS link and preloads — `web-artifacts`) and the
 * gateway (the server-rendered document head — `gateway/document_head.go`). A
 * second `</head>` anywhere earlier — a comment mentioning it — takes the
 * splice, and the import map lands inside a comment: every check passes and the
 * app boots blank. Kept a check rather than an assert in compose, whose source
 * is hashed into every artifact's address.
 */
const check: Check = {
  id: "shell-head-close-unique",
  description:
    "web-core's index.html contains `</head>` exactly once, so compose and the gateway splice into the real head",
  alwaysRun: true,
  async run() {
    const html = await readShell();
    const count = occurrences(html, "</head>");
    if (count === 1) return { ok: true };
    return {
      ok: false,
      message: `${INDEX_HTML} contains "</head>" ${count} times; it must contain it exactly once`,
      hint: 'Spell it differently in comments and scripts ("the end of the head").',
    };
  },
};

/** The exact bytes the gateway splices the page's static snapshot after. */
const ROOT_DIV = '<div id="root"></div>';

/**
 * The gateway (`gateway/snapshot.go`) inserts a crawlable page's static
 * snapshot (`apps/website/crawlable`) right after the exact bytes
 * `<div id="root"></div>`. Reformatting the mount point (an attribute, a space,
 * a self-closing tag) or mentioning it a second time — in the head, a comment —
 * moves or drops the snapshot silently: every page still boots, and robots read
 * an empty body again.
 */
const rootDivCheck: Check = {
  id: "shell-root-div-unique",
  description:
    'web-core\'s index.html contains `<div id="root"></div>` exactly once, in its body, so the gateway splices the static snapshot beside the real mount point',
  alwaysRun: true,
  async run() {
    const html = await readShell();
    const count = occurrences(html, ROOT_DIV);
    if (count !== 1) {
      return {
        ok: false,
        message: `${INDEX_HTML} contains ${JSON.stringify(ROOT_DIV)} ${count} times; it must contain it exactly once`,
        hint: "Keep the mount point spelled exactly so (no attributes, no whitespace inside), and spell it differently in comments and scripts.",
      };
    }
    const headClose = html.indexOf("</head>");
    if (headClose === -1 || html.indexOf(ROOT_DIV) < headClose) {
      return {
        ok: false,
        message: `${INDEX_HTML}: ${JSON.stringify(ROOT_DIV)} is not in the body (it comes before \`</head>\`)`,
      };
    }
    return { ok: true };
  },
};

export default [check, rootDivCheck];
