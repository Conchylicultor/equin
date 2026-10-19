import { readFileSync } from "fs";
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
    const root = await getWorktreeRoot();
    const html = readFileSync(join(root, INDEX_HTML), "utf8");
    const count = html.split("</head>").length - 1;
    if (count === 1) return { ok: true };
    return {
      ok: false,
      message: `${INDEX_HTML} contains "</head>" ${count} times; it must contain it exactly once`,
      hint: 'Spell it differently in comments and scripts ("the end of the head").',
    };
  },
};

export default check;
