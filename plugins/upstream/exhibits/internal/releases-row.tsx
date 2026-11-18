import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { INSTALLER_BINARIES } from "@plugins/installer/plugins/release-assets/core";
import type { Releasability } from "@plugins/upstream/plugins/release/core";
import { ReleasesBodyView } from "../../web/components/releases-row";
import {
  githubPublication,
  RELEASES_TITLE,
  releasesSubtitle,
  type Publisher,
} from "../../web/internal/releases-view";

const NOW = new Date("2026-11-17T14:00:00.000Z");
const SIX_HOURS_AGO = new Date(Date.now() - 6 * 3600_000).toISOString();
const SERVED = "247f2541c0ffee0000000000000000000000beef";
const BUILDING = "8c1e2f0aa000000000000000000000000000cafe";
const RUN_URL = "https://github.com/equinai/equin/actions/runs/1";
const RELEASE_URL = "https://github.com/equinai/equin/releases/tag/v2026.11.17";
const CORE_ASSETS = ["install.sh", "release.json", "SHA256SUMS"];
const PASSED_RUN = { status: "completed", conclusion: "success", url: RUN_URL };
const PUBLISHED = {
  draft: false,
  assets: [...CORE_ASSETS, ...Object.values(INSTALLER_BINARIES)],
  url: RELEASE_URL,
};

function publisher(
  releasable: Releasability,
  over: Partial<Publisher> = {},
): Publisher {
  return {
    kind: "publisher",
    latest: { tag: "v2026.11.17", taggedAt: SIX_HOURS_AGO },
    unreleased: 142,
    releasable,
    github: { kind: "connected", run: PASSED_RUN, release: PUBLISHED },
    ...over,
  };
}

const STATES: ReadonlyArray<{ name: string; status: Publisher }> = [
  { name: "Ready", status: publisher({ kind: "ready", commit: SERVED }) },
  {
    name: "Main is building",
    status: publisher({ kind: "building", commit: BUILDING }),
  },
  {
    name: "Main's build failed",
    status: publisher({ kind: "failed", commit: BUILDING, runId: "build-1" }),
  },
  {
    name: "Released",
    status: publisher(
      { kind: "released", commit: SERVED, tag: "v2026.11.17.2" },
      {
        latest: { tag: "v2026.11.17.2", taggedAt: new Date().toISOString() },
        unreleased: 0,
      },
    ),
  },
  {
    name: "Publishing on GitHub",
    status: publisher(
      { kind: "ready", commit: SERVED },
      {
        github: {
          kind: "connected",
          run: { status: "in_progress", conclusion: null, url: RUN_URL },
          release: null,
        },
      },
    ),
  },
  {
    name: "GitHub release failed",
    status: publisher(
      { kind: "ready", commit: SERVED },
      {
        github: {
          kind: "connected",
          run: { status: "completed", conclusion: "failure", url: RUN_URL },
          release: null,
        },
      },
    ),
  },
  {
    name: "GitHub not connected",
    status: publisher(
      { kind: "ready", commit: SERVED },
      { github: { kind: "not-connected", reason: "GitHub reconnecting" } },
    ),
  },
];

/** The subtitle as the row draws it: the release, then what GitHub did with it. */
function subtitleOf(status: Publisher): string {
  const subtitle = releasesSubtitle(status.latest);
  return status.github === null
    ? subtitle
    : `${subtitle} · ${githubPublication(status.github).words}`;
}

/** An exhibit releases nothing. */
const noRelease = async (): Promise<void> => {};

/** The row's title, subtitle and body in each state, as the report draws them. */
export default function ReleasesRowExhibit() {
  return (
    <Stack gap="lg">
      {STATES.map(({ name, status }) => (
        <Stack key={name} gap="2xs">
          <Text variant="caption" tone="muted">
            {name}
          </Text>
          <Text variant="label">{RELEASES_TITLE}</Text>
          <Text variant="caption" tone="muted">
            {subtitleOf(status)}
          </Text>
          <ReleasesBodyView status={status} now={NOW} onRelease={noRelease} />
        </Stack>
      ))}
    </Stack>
  );
}
