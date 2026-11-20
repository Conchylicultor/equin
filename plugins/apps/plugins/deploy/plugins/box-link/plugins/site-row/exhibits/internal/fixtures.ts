import type {
  BoxLink,
  LinkState,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import type { SiteExhibitState } from "../../web/slots";

const MIN = 60_000;
const GB = 1_000_000_000;
const MB = 1_000_000;

const MAIN_SHA = "9f1c2d3e4b5a69788796a5b4c3d2e1f0a9b8c7d6";
const RUNNING_SHA = "4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f";

interface Host {
  cpu: number;
  mem: number;
  disk: number;
}
const CALM: Host = { cpu: 4, mem: 410 * MB, disk: 0.38 * 25 * GB };
const BUSY: Host = { cpu: 61, mem: 780 * MB, disk: 0.41 * 25 * GB };

function link(
  id: string,
  state: LinkState,
  {
    host = CALM,
    heardAgoMin = 0,
    upSec = 6 * 86_400,
  }: { host?: Host; heardAgoMin?: number; upSec?: number } = {},
): BoxLink {
  const now = Date.now();
  const heard = now - heardAgoMin * MIN;
  return {
    deploymentId: id,
    state,
    since: heard,
    lastHeardAt: heard,
    lastBeat: {
      at: heard,
      seq: 42,
      host: {
        cpu: { busyPct: host.cpu, cores: 2, load1: 0.3 },
        mem: { used: host.mem, total: 1 * GB },
        disk: { used: host.disk, total: 25 * GB },
        uptimeSec: upSec,
      },
    },
    lastError: null,
    hello: { buildId: "b-exhibit", startedAt: now - upSec * 1000, v: 1 },
  };
}

function site(
  id: string,
  hostname: string,
  parts: Pick<SiteHealth, "link" | "run"> & { behind?: number },
): SiteHealth {
  return {
    deploymentId: id,
    compositionId: "website",
    hostname,
    link: parts.link,
    run: parts.run,
    release: {
      kind: "known",
      sha: RUNNING_SHA,
      subject: "Ship the visitors sparkline",
      behindMain: parts.behind ?? 0,
      mainSha: MAIN_SHA,
    },
  };
}

const DONE_RUN = {
  id: "drun-1795000000001-exh1",
  verb: "update" as const,
  phase: null,
  status: "succeeded" as const,
  startedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
  finishedAt: new Date(Date.now() - 6 * 86_400_000 + 72_000).toISOString(),
  message: null,
};

const ID = "dpl-1795000000001-exh1";

/** The deployed site in each of the row's six states — the prototype's. */
export function siteIn(state: SiteExhibitState): SiteHealth {
  const now = Date.now();
  switch (state) {
    case "live":
      return site(ID, "equin.ai", {
        link: { kind: "linked", link: link(ID, { kind: "live" }) },
        run: DONE_RUN,
      });
    case "deploying":
      return site(ID, "equin.ai", {
        link: {
          kind: "linked",
          link: link(ID, { kind: "live" }, { host: BUSY }),
        },
        run: {
          ...DONE_RUN,
          id: "drun-1795000000002-exh2",
          phase: "build",
          status: "running",
          startedAt: new Date(now - 72_000).toISOString(),
          finishedAt: null,
        },
        behind: 142,
      });
    case "behind":
      return site(ID, "equin.ai", {
        link: { kind: "linked", link: link(ID, { kind: "live" }) },
        run: DONE_RUN,
        behind: 142,
      });
    case "reconnecting":
      return site(ID, "equin.ai", {
        link: {
          kind: "linked",
          link: link(
            ID,
            {
              kind: "reconnecting",
              cause: "slept",
              graceUntil: now + MIN,
              then: "down",
              sshKind: null,
            },
            { heardAgoMin: 4 },
          ),
        },
        run: DONE_RUN,
      });
    case "down":
      return site(ID, "equin.ai", {
        link: {
          kind: "linked",
          link: link(ID, { kind: "down" }, { heardAgoMin: 17 }),
        },
        run: DONE_RUN,
      });
    case "failed":
      return site(ID, "equin.ai", {
        link: {
          kind: "linked",
          link: link(ID, { kind: "live" }, { upSec: 180 }),
        },
        run: {
          ...DONE_RUN,
          id: "drun-1795000000003-exh3",
          phase: "ship",
          status: "failed",
          startedAt: new Date(now - 5 * MIN).toISOString(),
          finishedAt: new Date(now - 3 * MIN).toISOString(),
          message:
            "The new version failed its health check — reverted to the previous one",
        },
      });
  }
}

const ID2 = "dpl-1795000000002-exh2";

/** A second site, live and current: the one-line row. */
export const SECOND_SITE: SiteHealth = site(ID2, "chord.equin.ai", {
  link: { kind: "linked", link: link(ID2, { kind: "live" }) },
  run: DONE_RUN,
});
