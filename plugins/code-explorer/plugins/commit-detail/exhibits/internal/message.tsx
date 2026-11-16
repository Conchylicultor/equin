import type { CommitDetail } from "@plugins/code-explorer/plugins/code-api/core";
import { CO_AUTHORED_BY_TRAILER_KEY } from "@plugins/primitives/plugins/commit-list/core";
import {
  ATTEMPT_TRAILER_KEY,
  CONVERSATION_TRAILER_KEY,
  PUSH_TRAILER_KEY,
} from "@plugins/tasks/plugins/tasks-core/core";
import { CommitMessage } from "../../web/components/commit-message";

const COMMIT: CommitDetail = {
  sha: "d16b747ce7055b893691c621b7ede3c480d0aa41",
  shortSha: "d16b747",
  subject:
    "fix(principal, gateway): nothing that came through a public edge is the owner",
  authorName: "Conchylicultor",
  authorEmail: "owner@example.invalid",
  authoredAt: "2026-11-15T02:35:00Z",
  parents: ["e077ef9213ab86f63a5c626c02642faf65000eb3"],
  trailers: [
    {
      key: CO_AUTHORED_BY_TRAILER_KEY,
      value: "Claude Opus 5.5 <noreply@anthropic.com>",
    },
    { key: CONVERSATION_TRAILER_KEY, value: "conv-1794814344-u7g2wo" },
    { key: ATTEMPT_TRAILER_KEY, value: "att-1794814300-kvade4" },
    { key: PUSH_TRAILER_KEY, value: "2507afe6-0c1d-4f7e-9a51-1d2e3f4a5b6c" },
  ],
  body: [
    "The gateway's `/gateway/*` control API was reachable from the internet: Caddy forwards every path, a public host counted as an equin host, and a request with no Sec-Fetch-Site and no Origin was the owner.",
    "",
    "- gateway: a new principal, `visitor` — a request whose Host is a public host or that carries any forwarding header came through an edge and is never the owner.",
    "- principal (TS): `visitor` kind, `PRINCIPAL_STAMPS` pinned to the Go constants by `principal:header-in-sync`.",
    "- Caddy: the site block refuses `/gateway/*` (second layer).",
    "",
    "Verified on a local website release behind a stand-in edge, then shipped.",
  ].join("\n"),
};

/** The header over a fixed commit. */
export default function CommitMessageExhibit() {
  return <CommitMessage commit={COMMIT} />;
}
