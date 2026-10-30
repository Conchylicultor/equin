import type { DeployFixture } from "@plugins/apps/plugins/deploy/plugins/fixtures/core";

// The film's Deploy state: one small server serving the public website, and a
// fortnight of updates to it, one of which failed and was fixed the next day.
// The address is in TEST-NET-3 (RFC 5737), which routes nowhere. The writer
// gives the server a real key (as Generate key does), stored under its id.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

export const FILM_DEPLOY: DeployFixture = {
  servers: [
    {
      id: "srv-1792800000-film01",
      name: "web-1",
      host: "203.0.113.24",
      health: { platform: "linux-x64", checkedAgoMs: 2 * HOUR },
      deployments: [
        {
          compositionId: "website",
          hostnames: ["piano-notes.example.com"],
          runs: [
            {
              verb: "update",
              status: "succeeded",
              startedAgoMs: 3 * HOUR,
              durationMs: 4 * MIN,
              commitSha: "4be1c9d27a0e5f3b8c6d1a9e2f7b0c3d5e8a1f64",
            },
            {
              verb: "update",
              status: "succeeded",
              startedAgoMs: 2 * DAY,
              durationMs: 5 * MIN,
              commitSha: "9a3f17c0b2e84d6f1a5c7e9b0d2f4a6c8e1b3d57",
            },
            {
              verb: "update",
              status: "failed",
              phaseFailed: "build",
              exitCode: 1,
              message: "build: type-check failed in the gallery page (1 error)",
              startedAgoMs: 3 * DAY,
              durationMs: 2 * MIN,
              commitSha: "c71e0b9d4a2f6e8c1b3d5f7a9e0c2b4d6f8a1c35",
            },
            {
              verb: "update",
              status: "succeeded",
              startedAgoMs: 7 * DAY,
              durationMs: 5 * MIN,
              commitSha: "e25d8a1c3f7b9e0d4a6c8f1b3e5d7a9c0e2f4b68",
            },
            {
              verb: "converge",
              status: "succeeded",
              startedAgoMs: 14 * DAY,
              durationMs: 9 * MIN,
              commitSha: null,
            },
          ],
        },
      ],
    },
  ],
};
