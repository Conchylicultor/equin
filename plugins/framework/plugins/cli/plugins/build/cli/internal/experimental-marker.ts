// The red "experimental" frame that marks an agent-worktree deploy.
//
// Whether an app is experimental is a fact the BUILD knows and the browser
// cannot infer. `<name>.localhost` is the namespace grammar for git-worktree
// deploys, for composition namespaces, and for local release
// previews alike — so the old client-side rule ("any subdomain that isn't
// `singularity`") painted the frame on compositions and releases too.
//
// The producer stamps it instead: a dist is experimental only because
// `./equin build` said so — the DEPLOY posture, and only from a non-main
// worktree. Every other producer (`build --hermetic`, the
// release/tauri bundles) is clean by DEFAULT rather than by exclusion, so a new
// way of shipping a dist can never inherit the frame by accident.
//
// The stamp is an inline head script that adds the `.experimental` class to
// <html> — the same JS-sets / CSS-styles split as `.dark`. The rule itself
// lives in ui-kit's `theme/app.css`.
//
// Except in an embedded document, in either mode. `?embed=…` (primitives/embed)
// means something else hosts this document — and that something is a page on
// this same deploy, which already wears the experimental frame. Drawing it
// again inside the embed says nothing new to a person, and puts a 3px red band
// into every picture of the embedded app (the prototype Compare stage's diff
// of a mock against the real screen). The stamp reads the same flag values the
// app does, spelled once in embed's core.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMBED_PARAM,
  EMBED_VALUES,
} from "@plugins/primitives/plugins/embed/core";

const STAMP =
  `<script>if(!${JSON.stringify(Object.values(EMBED_VALUES))}.includes(new URLSearchParams(location.search).get(${JSON.stringify(EMBED_PARAM)})))` +
  'document.documentElement.classList.add("experimental");</script>';

/**
 * Mark a staged dist as an experimental (agent-worktree) deploy. Runs on the
 * staging dir before the atomic publish — after the artifact composer has
 * written `index.html` there and before anything can serve it.
 */
export function stampExperimentalMarker(distDir: string): void {
  const path = resolve(distDir, "index.html");
  const html = readFileSync(path, "utf8");
  if (html.includes(STAMP)) return;
  if (!html.includes("</head>")) {
    throw new Error(`experimental marker: no </head> in ${path}`);
  }
  writeFileSync(path, html.replace("</head>", `    ${STAMP}\n  </head>`));
}
