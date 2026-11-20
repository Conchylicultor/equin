import type { ReactNode } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Meter } from "@plugins/primitives/plugins/css/plugins/meter/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import {
  boxLinks,
  type BoxHostMetrics,
  type BoxLink,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { SiteLiveExhibitProps, SiteLiveProps } from "../slots";
import { SiteLiveAside, SiteLiveBlock } from "./site-block";

/** A share past this is drawn amber: the box is working hard. */
const WARM_SHARE = 0.6;

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  const shown =
    v >= 10 || u === 0
      ? String(Math.round(v))
      : v.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[u]}`;
}

/** "6 d", "3 h", "12 min" — how long the box's equin has been up. */
function uptime(sec: number): string {
  if (sec >= 86_400) return `${Math.floor(sec / 86_400)} d`;
  if (sec >= 3_600) return `${Math.floor(sec / 3_600)} h`;
  return `${Math.max(1, Math.floor(sec / 60))} min`;
}

interface Reading {
  label: string;
  share: number;
  value: string;
  of: string;
}

function readings(host: BoxHostMetrics): Reading[] {
  const cpu =
    host.cpu.busyPct ?? Math.min(100, (host.cpu.load1 / host.cpu.cores) * 100);
  const cores = `of ${host.cpu.cores} core${host.cpu.cores === 1 ? "" : "s"}`;
  return [
    { label: "CPU", share: cpu / 100, value: `${Math.round(cpu)}%`, of: cores },
    {
      label: "Memory",
      share: host.mem.used / host.mem.total,
      value: bytes(host.mem.used),
      of: `of ${bytes(host.mem.total)}`,
    },
    {
      label: "Disk",
      share: host.disk.used / host.disk.total,
      value: `${Math.round((host.disk.used / host.disk.total) * 100)}%`,
      of: `of ${bytes(host.disk.total)}`,
    },
  ];
}

/**
 * The Server block: CPU, memory and disk from the box's last heartbeat, with
 * how long it has been up — or, once the link is not live, when it was last
 * heard, every meter dimmed (what is shown is that old). Nothing while the
 * box never sent a beat.
 */
export function ServerView({ link }: { link: BoxLink }): ReactNode {
  const beat = link.lastBeat;
  if (beat === null) return null;
  const live = link.state.kind === "live";
  const aside: ReactNode = (
    <SiteLiveAside>
      {live || link.lastHeardAt === null ? (
        <>
          {"Up "}
          <span className="font-semibold text-strong-foreground">
            {uptime(beat.host.uptimeSec)}
          </span>
        </>
      ) : (
        <>
          {"Last heard "}
          <span className="font-semibold text-strong-foreground">
            <RelativeTime date={new Date(link.lastHeardAt)} />
          </span>
        </>
      )}
    </SiteLiveAside>
  );
  return (
    <SiteLiveBlock title="Server" aside={aside}>
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- a three-track table (label | meter | value): the tracks line every reading up, which a row per reading cannot
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_4rem_6rem] items-center gap-x-sm gap-y-2xs whitespace-nowrap",
          !live && "opacity-45",
        )}
      >
        {readings(beat.host).map((r) => {
          const warm = r.share > WARM_SHARE;
          return [
            <Text key={`${r.label}-l`} variant="caption" tone="muted">
              {r.label}
            </Text>,
            <Meter
              key={`${r.label}-m`}
              value={r.share}
              label={r.label}
              size="thin"
              tone={warm ? "warning" : "success"}
            />,
            <Text
              key={`${r.label}-v`}
              variant="caption"
              tone="faint"
              className="text-right tabular-nums"
            >
              <span
                className={cn(
                  "font-semibold",
                  warm ? "text-warning" : "text-success",
                )}
              >
                {r.value}
              </span>{" "}
              {r.of}
            </Text>,
          ];
        })}
      </div>
    </SiteLiveBlock>
  );
}

/**
 * The live Server block: the link as `deploy.box-links` holds it — pushed on
 * every beat, which `deploy.site-health` deliberately is not. A site this
 * instance does not link (a real box seen from a worktree) has no meters here.
 */
export function ServerSection({ deploymentId }: SiteLiveProps): ReactNode {
  const links = useLive(boxLinks);
  switch (links.status) {
    case "ready": {
      const link = links.data[deploymentId];
      return link === undefined ? null : <ServerView link={link} />;
    }
    case "loading":
      return (
        <SiteLiveBlock title="Server">
          <Loading variant="rows" count={3} />
        </SiteLiveBlock>
      );
    case "error":
      return (
        <SiteLiveBlock title="Server">
          <ResourceErrorInline
            variant="inline"
            subject="the server's numbers"
            error={links.error}
            refetch={links.refetch}
          />
        </SiteLiveBlock>
      );
    // A host without the computer links no box: nothing to measure here.
    case "unavailable":
      return null;
  }
}

/** The exhibit's Server block: the fixture site's own link record. */
export function ServerSectionExhibit({
  site,
}: SiteLiveExhibitProps): ReactNode {
  return site.link.kind === "linked" ? (
    <ServerView link={site.link.link} />
  ) : null;
}
