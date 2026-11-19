import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/onboarding.tsx",
      "web/components/section-pane.tsx",
      "web/song-hydrator.tsx",
      "web/song-link.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — onboarding.tsx: SonataOnboarding (unsupported syntax: Handle TryStatement without a catch clause); section-pane.tsx: AvailableRailItem (calls a hook carried as a value); song-hydrator.tsx: SourceHydrator (calls a hook carried as a value); song-link.tsx: LinkPartReader (calls a hook carried as a value), SongLinkImport (unsupported syntax: Support value blocks (conditional, logical, optional chaining, etc) within a try/catch statement).",
  },
] satisfies Exemptions;
