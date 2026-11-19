import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-raw-websocket",
    paths: ["e2e/no-op-frames.ts"],
    kind: "sanctioned",
    reason:
      "A measurement script run under bun, not a browser tab: it speaks the live-resource wire protocol directly to count every frame the server sends, so it needs its own raw socket (SharedWebSocket is a browser SharedWorker primitive).",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/use-whole-transcript.ts"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — useWholeTranscript (an eslint-disable of a react-hooks rule in it makes the compiler skip it).",
  },
] satisfies Exemptions;
